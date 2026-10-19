import { describe, expect, it } from "vitest";

import {
  CONSULTATION_SERVICE_ID,
  CONSULTATION_SERVICE_NAME_UK,
  CREATE_CONFIRMATION_UK,
} from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
  type BookingEvent,
} from "../../booking-draft.js";
import { decideBooking } from "../decide.js";
import type { BookingInput, BookingReadModels } from "../decision.js";

const READ_MODELS: BookingReadModels = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: false,
};

const SLOT = {
  dateStart: "2026-09-10T14:00:00",
  dateEnd: "2026-09-10T14:30:00",
  label: "10 вер · 14:00",
};

const apply = (draft: BookingDraft | null, events: BookingEvent[]): BookingDraft | null => {
  let next = draft;
  for (const event of events) {
    next = reduceBookingDraft(next, event);
  }
  return next;
};

/** Draft advanced to the details phase (service + verified slot + note), phone only. */
const draftAtDetailsWithPhone = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-1", name: "Botox", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" });
  draft = reduceBookingDraft(draft, { type: "slot_selected", slot: SLOT, snapshotId: "snap-1" });
  draft = reduceBookingDraft(draft, { type: "note_status", status: "skipped" });
  draft = reduceBookingDraft(draft, {
    type: "contact_field_submitted",
    field: "phoneNumber",
    value: "+380501234567",
  });
  if (draft == null) {
    throw new Error("expected an active draft");
  }
  return draft;
};

describe("decideBooking atomic contract", () => {
  it("returns events and a decision, never a modified draft", () => {
    const input: BookingInput = { source: "control", intent: "menu" };
    const result = decideBooking(null, input, READ_MODELS);

    expect(Object.keys(result).sort()).toEqual(["decision", "events"]);
    expect(Array.isArray(result.events)).toBe(true);
    expect(result).not.toHaveProperty("session");
    expect(result).not.toHaveProperty("draft");
    expect(result.decision).not.toHaveProperty("session");
    expect(result.decision).not.toHaveProperty("replyText");
    expect(result.decision.tag).toBe("terminal");
    expect(result.decision.intent).toBe("menu");
  });

  it("maps a consultation intent to CONSULTATION_SERVICE_ID (never a literal)", () => {
    const input: BookingInput = {
      source: "semantic_patch",
      patch: { serviceIntent: { kind: "consultation" } },
    };
    const result = decideBooking(null, input, READ_MODELS);

    const serviceEvents = result.events.filter((e) => e.type === "service_selected");
    expect(serviceEvents).toHaveLength(1);
    const [event] = serviceEvents;
    expect(event?.type).toBe("service_selected");
    if (event?.type === "service_selected") {
      expect(event.service.id).toBe(CONSULTATION_SERVICE_ID);
      expect(event.service.id).not.toBe("consultation");
    }
    expect(result.decision.card).toMatchObject({
      kind: "service_confirm",
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
      labels: {
        offer_accept: "Так",
        offer_choose_other: "Обрати іншу процедуру",
      },
    });
  });

  it("looks up the contact by phone before asking for names", () => {
    const draft = draftAtDetailsWithPhone();
    const input: BookingInput = { source: "patient_turn", rawText: "" };
    const result = decideBooking(draft, input, READ_MODELS);

    expect(result.decision.tag).toBe("effect");
    expect(result.decision.pendingEffect?.effect.kind).toBe("lookup_contact_by_phone");
    // It must NOT jump straight to asking a name.
    const asksName = result.events.some(
      (e) =>
        e.type === "decision_set"
        && e.decision.kind === "clarification"
        && (e.decision.reason === "need_firstName" || e.decision.reason === "need_lastName"),
    );
    expect(asksName).toBe(false);
  });

  it("round-trips allowlisted informational facts onto an answer_side_question reply", () => {
    const input: BookingInput = {
      source: "effect_result",
      result: {
        effectId: "eff_1_get_working_time",
        kind: "informational",
        outcome: "ok",
        facts: { hours: "Пн–Пт 09:00–18:00", address: "вул. Прикладна 1" },
      },
    };
    const result = decideBooking(null, input, READ_MODELS);

    expect(result.decision.intent).toBe("answer_side_question");
    expect(result.decision.facts.hours).toBe("Пн–Пт 09:00–18:00");
    expect(result.decision.facts.address).toBe("вул. Прикладна 1");
  });

  it("decline_pending_service abandons and prepares list_services (not need_service)", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
      accepted: false,
    });
    expect(draft?.serviceAcceptance?.status).toBe("pending");

    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { serviceIntent: { kind: "decline_pending_service" } },
      },
      READ_MODELS,
    );

    expect(result.events.some((e) => e.type === "draft_abandoned")).toBe(true);
    expect(result.decision.tag).toBe("effect");
    expect(result.decision.pendingEffect?.effect.kind).toBe("list_services");
    expect(result.decision.card?.kind).not.toBe("clarification");
    expect(result.decision.reason).not.toBe("need_service");
  });

  it("reuses the prepared effect id when re-entering the same mutation confirm", () => {
    let draft: BookingDraft | null = draftAtDetailsWithPhone();
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "firstName",
      value: "Іван",
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "lastName",
      value: "Петренко",
    });
    draft = reduceBookingDraft(draft, { type: "contact_resolved", contactId: "contact-1" });
    expect(draft?.phase).toBe("ready");

    const first = decideBooking(draft, { source: "patient_turn", rawText: "" }, READ_MODELS);
    expect(first.decision.tag).toBe("mutation_confirm");
    const firstId = first.decision.pendingEffect?.id;
    expect(firstId).toBeTruthy();
    expect(first.events.some((e) => e.type === "effect_prepared")).toBe(true);

    const applied = apply(draft, first.events);
    const second = decideBooking(applied, { source: "patient_turn", rawText: "" }, READ_MODELS);

    expect(second.decision.pendingEffect?.id).toBe(firstId);
    // No second effect_prepared minting a fresh id on re-entry.
    expect(second.events.some((e) => e.type === "effect_prepared")).toBe(false);

    const effect = first.decision.pendingEffect?.effect;
    expect(effect?.kind).toBe("create_meeting");
    if (effect?.kind === "create_meeting") {
      expect(effect.payload.name).toBe("Botox - Іван Петренко");
      expect(effect.payload.confirmMessage).toBe(CREATE_CONFIRMATION_UK);
      expect(effect.payload.contactId).toBe("contact-1");
      expect(effect.payload.serviceId).toBe("svc-1");
    }
  });

  it("create_meeting name uses Консультація, never the CRM service id", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      // Name omitted — mirrors live consultation accept before the name stamp fix.
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" });
    draft = reduceBookingDraft(draft, { type: "slot_selected", slot: SLOT, snapshotId: "snap-1" });
    draft = reduceBookingDraft(draft, { type: "note_status", status: "skipped" });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "+380501234567",
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "firstName",
      value: "Daniel",
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "lastName",
      value: "Testing",
    });
    draft = reduceBookingDraft(draft, { type: "contact_resolved", contactId: "contact-1" });
    expect(draft?.phase).toBe("ready");

    const result = decideBooking(draft, { source: "patient_turn", rawText: "" }, READ_MODELS);
    const effect = result.decision.pendingEffect?.effect;
    expect(effect?.kind).toBe("create_meeting");
    if (effect?.kind === "create_meeting") {
      expect(effect.payload.name).toBe(`${CONSULTATION_SERVICE_NAME_UK} - Daniel Testing`);
      expect(effect.payload.name).not.toContain(CONSULTATION_SERVICE_ID);
    }
  });

  it("skips phone lookup when contactId is already set and asks only missing names", () => {
    let draft: BookingDraft | null = draftAtDetailsWithPhone();
    draft = reduceBookingDraft(draft, { type: "contact_resolved", contactId: "owned-1" });
    // Phone remains in details; names still missing.
    expect(draft?.contactId).toBe("owned-1");
    expect(draft?.phase).toBe("details");

    const result = decideBooking(draft, { source: "patient_turn", rawText: "" }, READ_MODELS);
    expect(result.decision.pendingEffect?.effect.kind).not.toBe("lookup_contact_by_phone");
    expect(result.decision.card).toMatchObject({
      kind: "contact_field",
      field: "firstName",
    });
  });

  it("clears details on contact_write when crmComplete", () => {
    let draft: BookingDraft | null = draftAtDetailsWithPhone();
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_1_link_telegram_contact",
        expectedRevision: 1,
        effect: { kind: "link_telegram_contact", contactId: "c-linked" },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_link_telegram_contact",
          kind: "contact_write",
          outcome: "linked",
          contactId: "c-linked",
          crmComplete: true,
        },
      },
      READ_MODELS,
    );

    const resolved = result.events.find((e) => e.type === "contact_resolved");
    expect(resolved).toMatchObject({
      type: "contact_resolved",
      contactId: "c-linked",
      clearDetails: true,
    });
  });
});

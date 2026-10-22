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
import { choiceIdsFromCard } from "../../agent-loop/booking-card-choices.js";
import { askDecisionFromPendingView, decideBooking } from "../decide.js";
import type { BookingInput, BookingReadModels } from "../decision.js";

const READ_MODELS: BookingReadModels = {
  assignedUserId: "assigned-user-1",
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
    });
    // Labels are projection/composer-owned — kernel cards stay language-neutral.
    expect(
      result.decision.card != null
      && "labels" in result.decision.card
        ? result.decision.card.labels
        : undefined,
    ).toBeUndefined();
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

  it("resumes open time_select card on answer_side_question after get_service", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: CONSULTATION_SERVICE_NAME_UK, source: "catalog" },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "time_select",
        date: "2026-09-10",
        snapshotId: "snap-1",
        choiceIds: ["s1", "other_date"],
        labels: { s1: "14:00", other_date: "Інша дата" },
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_2_get_service",
        expectedRevision: 2,
        effect: { kind: "get_service", serviceId: CONSULTATION_SERVICE_ID },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_2_get_service",
          kind: "informational",
          outcome: "ok",
          facts: {
            servicePrice: "500",
            serviceName: CONSULTATION_SERVICE_NAME_UK,
            serviceId: CONSULTATION_SERVICE_ID,
          },
        },
      },
      READ_MODELS,
    );

    expect(result.decision.intent).toBe("answer_side_question");
    expect(result.decision.facts.servicePrice).toBe("500");
    expect(result.decision.card).toMatchObject({
      kind: "time_select",
      date: "2026-09-10",
      choiceIds: ["s1", "other_date"],
    });
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
    const frozen = applied?.pendingDecision;
    expect(frozen?.kind).toBe("mutation_confirm");
    if (frozen?.kind === "mutation_confirm") {
      expect(frozen.frozenCommand).toMatchObject({
        action: "create",
        effectId: firstId,
        payload: {
          name: "Botox - Іван Петренко",
          assignedUserId: "assigned-user-1",
          parentType: "Contact",
          parentId: "contact-1",
          contactsIds: ["contact-1"],
          cServicesIds: ["svc-1"],
          status: "Planned",
          dateStart: SLOT.dateStart,
          dateEnd: SLOT.dateEnd,
        },
      });
      expect(frozen.frozenCommand?.payload).not.toHaveProperty("confirmMessage");
      expect(frozen.frozenCommand?.payload).not.toHaveProperty("serviceId");
      expect(frozen.frozenCommand?.payload).not.toHaveProperty("contactId");
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

  it("book-with-visit offers REPLACE visit_select instead of consultation", () => {
    const meeting = {
      id: "meeting-1",
      name: "Консультація",
      dateStart: "2026-10-21T10:00:00",
      dateEnd: "2026-10-21T10:30:00",
    };
    const result = decideBooking(
      null,
      { source: "semantic_patch", patch: { serviceIntent: { kind: "consultation" } } },
      { ...READ_MODELS, plannedMeetings: [meeting] },
    );
    expect(result.events.some((e) => e.type === "existing_booking_detected")).toBe(true);
    expect(result.decision.card).toMatchObject({
      kind: "visit_select",
      stage: "replacement",
    });
    expect(result.decision.pendingEffect).toBeUndefined();
  });

  it("active view projects REPLACE visit_select with cancel_existing offered ids", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: {
        id: "meeting-1",
        name: "Консультація",
        dateStart: "2026-10-21T10:00:00",
        dateEnd: "2026-10-21T10:30:00",
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: { kind: "visit_select", stage: "replacement" },
    });
    const view = askDecisionFromPendingView(draft);
    expect(view?.card).toMatchObject({ kind: "visit_select", stage: "replacement" });
    expect(choiceIdsFromCard(view?.card ?? null)).toEqual(["cancel_existing", "decline"]);
  });

  it("cancel_existing choice emits cancel_existing_requested (cancelling), not visit_cancel", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: {
        id: "meeting-1",
        name: "Консультація",
        dateStart: "2026-10-21T10:00:00",
        dateEnd: "2026-10-21T10:30:00",
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: { kind: "visit_select", stage: "replacement" },
    });
    expect(draft?.replacement?.status).toBe("offered");

    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { choice: { choiceId: "cancel_existing" } },
      },
      READ_MODELS,
    );

    expect(result.events.some((e) => e.type === "cancel_existing_requested")).toBe(true);
    const after = apply(draft, result.events);
    expect(after?.replacement?.status).toBe("cancelling");
    expect(result.decision.tag).toBe("mutation_confirm");
    expect(result.decision.card).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
  });

  it("present_availability includes excludeMeetingIds while rescheduling", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "meeting-rs",
        name: "Консультація",
        dateStart: "2026-10-21T10:00:00",
        dateEnd: "2026-10-21T10:30:00",
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog", durationMinutes: 30 },
      accepted: true,
    });
    expect(draft?.mode).toBe("reschedule");

    const result = decideBooking(
      draft,
      { source: "semantic_patch", patch: {} },
      READ_MODELS,
    );
    expect(result.decision.tag).toBe("effect");
    const effect = result.decision.pendingEffect?.effect;
    expect(effect?.kind).toBe("present_availability");
    if (effect?.kind === "present_availability") {
      expect(effect.excludeMeetingIds).toEqual(["meeting-rs"]);
      expect(effect.durationMinutes).toBe(30);
    }
  });

  it("confirming with pendingCommand cancel emits cancel_meeting mutation_confirm", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "command_prepared",
      command: {
        action: "cancel",
        payload: {
          meetingId: "meeting-1",
          confirmMessage: "Підтвердити скасування?",
        },
      },
    });
    expect(draft?.phase).toBe("confirming");
    expect(draft?.pendingCommand?.action).toBe("cancel");
    expect(draft?.pendingDecision).toBeNull();

    const result = decideBooking(
      draft,
      { source: "semantic_patch", patch: {} },
      READ_MODELS,
    );

    expect(result.decision.tag).toBe("mutation_confirm");
    expect(result.decision.intent).toBe("confirm_cancel");
    expect(result.decision.card).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
    expect(result.decision.pendingEffect?.effect.kind).toBe("cancel_meeting");
    expect(result.decision.reason).not.toBe("awaiting_confirm");
  });

  it("controlKind visit_cancel with one planned meeting opens cancel HITL", () => {
    const meeting = {
      id: "meeting-1",
      name: "Консультація",
      dateStart: "2026-10-23 12:00:00",
      dateEnd: "2026-10-23 13:00:00",
    };
    const result = decideBooking(
      null,
      { source: "semantic_patch", patch: { controlIntent: { kind: "visit_cancel" } } },
      { ...READ_MODELS, plannedMeetings: [meeting] },
    );

    expect(result.decision.tag).toBe("mutation_confirm");
    expect(result.decision.intent).toBe("confirm_cancel");
    expect(result.decision.pendingEffect?.effect).toMatchObject({
      kind: "cancel_meeting",
      payload: { meetingId: "meeting-1" },
    });
    const draft = apply(null, result.events);
    expect(draft?.pendingCommand?.action).toBe("cancel");
  });

  it("abandon does not wipe a just-seeded cancel pendingCommand before HITL", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "command_prepared",
      command: {
        action: "cancel",
        payload: {
          meetingId: "meeting-1",
          confirmMessage: "Підтвердити скасування?",
        },
      },
    });
    expect(draft?.pendingDecision).toBeNull();

    const result = decideBooking(
      draft,
      { source: "semantic_patch", patch: { controlIntent: { kind: "abandon" } } },
      READ_MODELS,
    );

    expect(result.decision.tag).toBe("mutation_confirm");
    expect(result.decision.intent).toBe("confirm_cancel");
    expect(result.events.some((e) => e.type === "draft_abandoned")).toBe(false);
    const next = apply(draft, result.events);
    expect(next?.pendingCommand?.action).toBe("cancel");
  });

  it("mutation declined closes to main menu without get_working_time", () => {
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
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_1_create_meeting",
        expectedRevision: 1,
        effect: {
          kind: "create_meeting",
          payload: {
            serviceId: "svc-1",
            contactId: "contact-1",
            dateStart: SLOT.dateStart,
            dateEnd: SLOT.dateEnd,
            name: "Botox - Іван Петренко",
            confirmMessage: CREATE_CONFIRMATION_UK,
          },
        },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_create_meeting",
          kind: "mutation",
          action: "create",
          outcome: "declined",
        },
      },
      READ_MODELS,
    );

    expect(result.events.some((e) => e.type === "draft_abandoned")).toBe(true);
    expect(result.decision).toMatchObject({
      tag: "terminal",
      intent: "menu",
      reason: "menu",
    });
    expect(result.decision.pendingEffect).toBeUndefined();
    expect(result.decision.tag).not.toBe("effect");
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

  it("create_meeting name uses ownedContact after clearDetails wiped draft names", () => {
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
    draft = reduceBookingDraft(draft, {
      type: "contact_resolved",
      contactId: "contact-1",
      clearDetails: true,
    });
    expect(draft?.contactDetails ?? null).toBeNull();
    expect(draft?.phase).toBe("ready");

    const withNames = decideBooking(
      draft,
      { source: "patient_turn", rawText: "" },
      {
        ...READ_MODELS,
        ownedContact: { firstName: "Іван", lastName: "Петренко" },
      },
    );
    const named = withNames.decision.pendingEffect?.effect;
    expect(named?.kind).toBe("create_meeting");
    if (named?.kind === "create_meeting") {
      expect(named.payload.name).toBe("Botox - Іван Петренко");
    }

    const withoutNames = decideBooking(
      draft,
      { source: "patient_turn", rawText: "" },
      READ_MODELS,
    );
    const bare = withoutNames.decision.pendingEffect?.effect;
    expect(bare?.kind).toBe("create_meeting");
    if (bare?.kind === "create_meeting") {
      expect(bare.payload.name).toBe("Botox");
    }
  });

  it("REPLACE cancel without accepted service opens list_services catalog effect", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: {
        id: "meeting-old",
        name: "Консультація",
        dateStart: "2026-10-21T10:00:00",
        dateEnd: "2026-10-21T10:30:00",
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "cancel_existing_requested",
      command: {
        action: "cancel",
        payload: {
          meetingId: "meeting-old",
          confirmMessage: "Підтвердити скасування?",
        },
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_1_cancel_meeting",
        expectedRevision: 1,
        effect: {
          kind: "cancel_meeting",
          payload: { meetingId: "meeting-old" },
        },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_cancel_meeting",
          kind: "mutation",
          action: "cancel",
          outcome: "committed",
        },
      },
      READ_MODELS,
    );

    expect(result.decision.tag).toBe("effect");
    expect(result.decision.pendingEffect?.effect.kind).toBe("list_services");
    expect(result.events.some((e) => e.type === "cancel_existing_completed")).toBe(true);
  });

  it("contactFormatError phone re-asks contact_field with invalid_phone facts", () => {
    const draft = draftAtDetailsWithPhone();
    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { contactFormatError: "phoneNumber" },
      },
      READ_MODELS,
    );
    expect(result.decision).toMatchObject({
      tag: "ask",
      intent: "ask_phone",
      reason: "invalid_phone",
      facts: { clarificationReason: "invalid_phone" },
      card: { kind: "contact_field", field: "phoneNumber" },
    });
    expect(
      result.events.some(
        (e) => e.type === "contact_field_submitted",
      ),
    ).toBe(false);
  });

  it("contactFormatError firstName re-asks with invalid_firstName facts", () => {
    let draft: BookingDraft | null = draftAtDetailsWithPhone();
    draft = reduceBookingDraft(draft, {
      type: "phone_lookup_recorded",
      evidence: {
        phoneNumber: "+380501234567",
        result: "none",
        contactIds: [],
      },
    });
    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { contactFormatError: "firstName" },
      },
      READ_MODELS,
    );
    expect(result.decision).toMatchObject({
      tag: "ask",
      intent: "ask_first_name",
      reason: "invalid_firstName",
      facts: { clarificationReason: "invalid_firstName" },
      card: { kind: "contact_field", field: "firstName" },
    });
  });

  it("contactFormatError lastName re-asks with invalid_lastName facts", () => {
    let draft: BookingDraft | null = draftAtDetailsWithPhone();
    draft = reduceBookingDraft(draft, {
      type: "phone_lookup_recorded",
      evidence: {
        phoneNumber: "+380501234567",
        result: "none",
        contactIds: [],
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "firstName",
      value: "Smoke",
    });
    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { contactFormatError: "lastName" },
      },
      READ_MODELS,
    );
    expect(result.decision).toMatchObject({
      tag: "ask",
      intent: "ask_last_name",
      reason: "invalid_lastName",
      facts: { clarificationReason: "invalid_lastName" },
      card: { kind: "contact_field", field: "lastName" },
    });
  });

  it("availability error fails closed without reminting present_availability", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog", durationMinutes: 30 },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_1_present_availability",
        expectedRevision: 1,
        effect: { kind: "present_availability", queryKind: "nearest" },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_present_availability",
          kind: "availability",
          outcome: "error",
        },
      },
      READ_MODELS,
    );

    expect(result.decision).toMatchObject({
      tag: "ask",
      intent: "clarification",
      reason: "availability_failed",
    });
    expect(result.decision.pendingEffect).toBeUndefined();
    expect(
      result.events.some(
        (e) =>
          e.type === "effect_prepared"
          && e.effect.effect.kind === "present_availability",
      ),
    ).toBe(false);
  });

  it("open catalog page beats a pending service offer across empty and side-question turns", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-offer", name: "Консультація", source: "catalog" },
      accepted: false,
    });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-a", name: "Botox A" },
          { id: "svc-b", name: "Botox B" },
        ],
        choices: [
          { id: "svc-a", label: "Botox A", serviceIds: ["svc-a"] },
          { id: "svc-b", label: "Botox B", serviceIds: ["svc-b"] },
        ],
      },
    });

    const emptyTurn = decideBooking(
      draft,
      { source: "semantic_patch", patch: {} },
      READ_MODELS,
    );
    expect(emptyTurn.decision.card).toMatchObject({
      kind: "service_candidate",
      choices: [
        { id: "svc-a", label: "Botox A" },
        { id: "svc-b", label: "Botox B" },
      ],
    });

    const side = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { informationalQuestion: "address" },
      },
      READ_MODELS,
    );
    expect(side.decision.card).toMatchObject({
      kind: "service_candidate",
      choices: [
        { id: "svc-a", label: "Botox A" },
        { id: "svc-b", label: "Botox B" },
      ],
    });
  });

  it("availability error does not re-offer an open DATE/TIME wait", () => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog", durationMinutes: 30 },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "time_select",
        date: "2026-09-10",
        snapshotId: "snap-1",
        choiceIds: ["s1", "other_date"],
        labels: { s1: "14:00", other_date: "Інша дата" },
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_revalidate",
        expectedRevision: draft!.version + 1,
        effect: {
          kind: "present_availability",
          queryKind: "exact",
          date: "2026-09-10",
          revalidate: true,
        },
        status: "executing",
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_revalidate",
          kind: "availability",
          outcome: "error",
        },
      },
      READ_MODELS,
    );
    expect(result.decision.card?.kind).not.toBe("time_select");
    expect(result.decision.card?.kind).not.toBe("date_select");
    expect(result.decision).toMatchObject({
      reason: "availability_failed",
    });
  });
});

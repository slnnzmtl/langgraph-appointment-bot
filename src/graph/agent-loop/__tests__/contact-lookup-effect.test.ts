import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
  type BookingEvent,
} from "../../booking-draft.js";
import { decideBooking } from "../../booking-domain/decide.js";
import type { BookingReadModels } from "../../booking-domain/decision.js";
import type { PendingEffect } from "../../booking-domain/effects.js";
import {
  createBookingDecideNode,
  effectResultFromToolMessages,
} from "../booking-decide-nodes.js";

const READ: BookingReadModels = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: false,
};

const apply = (draft: BookingDraft | null, events: BookingEvent[]): BookingDraft | null => {
  let next = draft;
  for (const event of events) {
    next = reduceBookingDraft(next, event);
  }
  return next;
};

const lookupPending = (phone: string, id = "eff_1_lookup_contact_by_phone"): PendingEffect => ({
  id,
  expectedRevision: 1,
  effect: { kind: "lookup_contact_by_phone", phoneNumber: phone },
  status: "prepared",
});

const draftAwaitingLookup = (phone: string): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, {
    type: "date_selected",
    date: "2026-10-21",
  });
  draft = reduceBookingDraft(draft, {
    type: "slot_selected",
    slot: {
      dateStart: "2026-10-21T10:00:00+03:00",
      dateEnd: "2026-10-21T10:30:00+03:00",
      label: "10:00",
    },
    snapshotId: "snap-1",
  });
  draft = reduceBookingDraft(draft, { type: "note_status", status: "skipped" });
  draft = reduceBookingDraft(draft, {
    type: "contact_field_submitted",
    field: "phoneNumber",
    value: phone,
  });
  draft = reduceBookingDraft(draft, {
    type: "effect_prepared",
    effect: lookupPending(phone),
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

describe("effectResultFromToolMessages contact lookup", () => {
  const phone = "+380931233323";

  it("classifies contacts payload via normalize + classifyPhoneLookupResult", () => {
    const pending = lookupPending(phone);
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            contacts: [{ id: "c-1", firstName: "A", lastName: "B", phoneNumber: phone }],
          }),
          tool_call_id: pending.id,
          name: "find_contact_by_phone",
        }),
      ],
      pending,
    );
    expect(result).toMatchObject({
      kind: "contact_lookup",
      outcome: "single_linkable",
      contactIds: ["c-1"],
      phoneNumber: phone,
    });
  });

  it("classifies list payload the same way", () => {
    const pending = lookupPending(phone);
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({ list: [] }),
          tool_call_id: pending.id,
          name: "find_contact_by_phone",
        }),
      ],
      pending,
    );
    expect(result).toMatchObject({
      kind: "contact_lookup",
      outcome: "none",
      contactIds: [],
      phoneNumber: phone,
    });
  });

  it("maps { error } and malformed bodies to contact_lookup error", () => {
    const pending = lookupPending(phone);
    expect(
      effectResultFromToolMessages(
        [
          new ToolMessage({
            content: JSON.stringify({ error: "CRM down" }),
            tool_call_id: pending.id,
            name: "find_contact_by_phone",
          }),
        ],
        pending,
      ),
    ).toMatchObject({ kind: "contact_lookup", outcome: "error", phoneNumber: phone });

    expect(
      effectResultFromToolMessages(
        [
          new ToolMessage({
            content: "not-json",
            tool_call_id: pending.id,
            name: "find_contact_by_phone",
          }),
        ],
        pending,
      ),
    ).toMatchObject({ kind: "contact_lookup", outcome: "error" });
  });

  it("uses pending effect phoneNumber, not contacts in the body", () => {
    const pending = lookupPending("+380501111111");
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({ contacts: [] }),
          tool_call_id: pending.id,
          name: "find_contact_by_phone",
        }),
      ],
      pending,
    );
    expect(result).toMatchObject({ phoneNumber: "+380501111111", outcome: "none" });
  });
});

describe("contact lookup consume-once (kernel)", () => {
  const phone = "+380931233323";

  it("records evidence and does not mint a second lookup on the next patient_turn", () => {
    const draft = draftAwaitingLookup(phone);
    const first = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_lookup_contact_by_phone",
          kind: "contact_lookup",
          outcome: "none",
          contactIds: [],
          phoneNumber: phone,
        },
      },
      READ,
    );
    expect(first.decision.pendingEffect).toBeUndefined();
    expect(first.events.some((e) => e.type === "phone_lookup_recorded")).toBe(true);
    expect(first.events.some((e) => e.type === "effect_prepared")).toBe(false);

    const after = apply(draft, first.events);
    const again = decideBooking(after, { source: "patient_turn", rawText: "" }, READ);
    expect(again.decision.pendingEffect?.effect.kind).not.toBe("lookup_contact_by_phone");
  });

  it("on lookup error asks for phone and does not re-prepare lookup", () => {
    const draft = draftAwaitingLookup(phone);
    const result = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_lookup_contact_by_phone",
          kind: "contact_lookup",
          outcome: "error",
          phoneNumber: phone,
        },
      },
      READ,
    );
    expect(result.decision.tag).toBe("ask");
    expect(result.decision.card?.kind).toBe("contact_field");
    expect(result.decision.pendingEffect).toBeUndefined();
    expect(result.events.some((e) => e.type === "effect_prepared")).toBe(false);
    expect(result.events.some((e) => e.type === "phone_lookup_recorded")).toBe(false);
  });
});

describe("createBookingDecideNode mainBook + contact fail-closed", () => {
  it("exact Записатись bypasses the interpreter and opens consultation confirm", async () => {
    const interpretTurn = async () => {
      throw new Error("interpreter must not run for mainBook");
    };
    const node = createBookingDecideNode({ interpretTurn });
    const update = await node({
      messages: [new HumanMessage("Записатись")],
      agentMessages: [],
      bookingDraft: null,
      pendingInteraction: null,
      availabilityContext: null,
    } as never);

    expect(update.bookingDecision?.intent).toBe("confirm_service");
    expect(update.bookingDecision?.card).toMatchObject({
      kind: "service_confirm",
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
      labels: {
        offer_accept: "Так",
        offer_choose_other: "Обрати іншу процедуру",
      },
    });
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.pendingInteraction?.kind === "service_confirm"
      ? update.pendingInteraction.choices.map((c) => c.id)
      : []).toEqual(["offer_accept", "offer_choose_other"]);
  });

  it("fail-closes when pending lookup has a ToolMessage that cannot be translated", async () => {
    const phone = "+380931233323";
    const pending = lookupPending(phone, "eff_8_lookup_contact_by_phone");
    const draft = {
      ...draftAwaitingLookup(phone),
      pendingEffect: pending,
    };
    const node = createBookingDecideNode();
    const update = await node({
      messages: [new HumanMessage(phone)],
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          tool_call_id: pending.id,
          name: "find_contact_by_phone",
        }),
      ],
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: null,
    } as never);

    expect(update.bookingDecision?.pendingEffect).toBeUndefined();
    expect(update.bookingDecision?.card?.kind).toBe("contact_field");
    // Must not stamp another find_contact_by_phone in this hop.
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    expect((update.agentMessages as Overwrite<unknown[]>).value).toEqual([]);
  });

  it("fail-closes when pendingEffect has no matching ToolMessage", async () => {
    const phone = "+380931233323";
    const pending = lookupPending(phone, "eff_8_lookup_contact_by_phone");
    const draft = {
      ...draftAwaitingLookup(phone),
      pendingEffect: pending,
    };
    const node = createBookingDecideNode({
      interpretTurn: async () => {
        throw new Error("must not re-interpret while effect is open");
      },
    });
    const update = await node({
      messages: [new HumanMessage(phone)],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: null,
    } as never);

    // Contact lookup error → ask for phone again, do not re-mint lookup.
    expect(update.bookingDecision?.pendingEffect).toBeUndefined();
    expect(update.bookingDecision?.card?.kind).toBe("contact_field");
  });
});

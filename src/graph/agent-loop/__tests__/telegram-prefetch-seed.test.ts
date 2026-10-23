import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking/booking-draft.js";
import {
  createBookingDecideNode,
  seedDraftFromTelegramPrefetch,
} from "../booking-decide-nodes.js";

const SLOT = {
  dateStart: "2026-10-21T11:00:00+03:00",
  dateEnd: "2026-10-21T11:30:00+03:00",
  label: "11:00",
};

const draftPastNote = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-10-21" });
  draft = reduceBookingDraft(draft, {
    type: "slot_selected",
    slot: SLOT,
    snapshotId: "snap-1",
  });
  draft = reduceBookingDraft(draft, { type: "note_status", status: "skipped" });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

describe("seedDraftFromTelegramPrefetch", () => {
  it("seeds ladder fields + contact_resolved for a complete telegram-owned CRM row", () => {
    const { draft, events } = seedDraftFromTelegramPrefetch(draftPastNote(), {
      ownership: "telegram",
      contacts: [{
        id: "c-owned",
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501111111",
      }],
    });
    expect(events.filter((e) => e.type === "contact_field_submitted")).toHaveLength(3);
    expect(events.some((e) => e.type === "contact_resolved")).toBe(true);
    expect(draft?.contactId).toBe("c-owned");
    expect(draft?.contactDetails).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumber: "+380501111111",
    });
    expect(draft?.phase).toBe("ready");
  });

  it("copies known ladder fields then resolves when CRM is incomplete", () => {
    const { draft, events } = seedDraftFromTelegramPrefetch(draftPastNote(), {
      ownership: "telegram",
      contacts: [{
        id: "c-partial",
        phoneNumber: "+380502222222",
      }],
    });
    expect(events.some((e) =>
      e.type === "contact_field_submitted" && e.field === "phoneNumber"
    )).toBe(true);
    expect(events.some((e) => e.type === "contact_resolved")).toBe(true);
    expect(draft?.contactId).toBe("c-partial");
    expect(draft?.contactDetails?.phoneNumber).toBe("+380502222222");
    expect(draft?.phase).toBe("details");
  });

  it("does nothing for phone ownership or empty context", () => {
    const base = draftPastNote();
    expect(seedDraftFromTelegramPrefetch(base, {
      ownership: "phone",
      contacts: [{ id: "c-phone", phoneNumber: "+380503333333" }],
    }).events).toEqual([]);
    expect(seedDraftFromTelegramPrefetch(base, null).events).toEqual([]);
    expect(seedDraftFromTelegramPrefetch(base, { contacts: [] }).events).toEqual([]);
  });
});

describe("createBookingDecideNode telegram prefetch seed", () => {
  it("goes to create HITL without asking phone when telegram CRM is complete", async () => {
    // Empty patient text → decideFromRequirement (seed already applied).
    const node = createBookingDecideNode({ assignedUserId: "assigned-user-1" });
    const update = await node({
      messages: [new HumanMessage("")],
      agentMessages: [],
      bookingDraft: draftPastNote(),
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-owned",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501111111",
        }],
      },
      pendingInteraction: null,
      availabilityContext: null,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDraft?.contactId).toBe("c-owned");
    expect(update.bookingDecision?.tag).toBe("mutation_confirm");
    expect(update.bookingDecision?.pendingEffect?.effect.kind).toBe("create_meeting");
    const effect = update.bookingDecision?.pendingEffect?.effect;
    if (effect?.kind === "create_meeting") {
      expect(effect.payload.name).toBe("Консультація - Ada Lovelace");
      expect(effect.payload.confirmMessage.length).toBeGreaterThan(0);
    }
  });

  it("asks firstName only (no phone lookup) when telegram CRM lacks names", async () => {
    const node = createBookingDecideNode();
    const update = await node({
      messages: [new HumanMessage("")],
      agentMessages: [],
      bookingDraft: draftPastNote(),
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-partial",
          phoneNumber: "+380502222222",
        }],
      },
      pendingInteraction: null,
      availabilityContext: null,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDraft?.contactId).toBe("c-partial");
    expect(update.bookingDecision?.pendingEffect?.effect.kind).not.toBe(
      "lookup_contact_by_phone",
    );
    expect(update.bookingDecision?.card).toMatchObject({
      kind: "contact_field",
      field: "firstName",
    });
  });
});

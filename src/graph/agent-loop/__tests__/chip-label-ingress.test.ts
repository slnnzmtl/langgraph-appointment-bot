import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  CONSULTATION_SERVICE_ID,
  OTHER_DATE_LABEL,
} from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import { interpretBookingTurnDeterministic } from "../../booking-domain/interpret.js";
import type { InterpretBookingTurnInput } from "../../booking-domain/interpret.js";
import { createBookingDecideNode } from "../booking-decide-nodes.js";

/** Mirror production: deterministic first, then optional LLM stub. */
const withDeterministicFirst = (
  llm?: (input: InterpretBookingTurnInput) => Promise<Record<string, never>>,
) =>
  async (input: InterpretBookingTurnInput) => {
    const deterministic = interpretBookingTurnDeterministic(input);
    if (Object.keys(deterministic).length > 0) {
      return deterministic;
    }
    return llm != null ? llm(input) : {};
  };

const SLOT_ID = "2026-10-20T1100";
const DATE_ID = "2026-10-20";

const draftAtTimeSelect = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, { type: "date_selected", date: DATE_ID });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: {
      kind: "time_select",
      date: DATE_ID,
      snapshotId: "snap-1",
      choiceIds: [SLOT_ID, "other_date"],
      labels: {
        [SLOT_ID]: "11:00",
        other_date: OTHER_DATE_LABEL,
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: [SLOT_ID, "other_date"],
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

const draftAtDateSelect = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: {
      kind: "date_select",
      snapshotId: "snap-1",
      choiceIds: [DATE_ID, "other_date"],
      labels: {
        [DATE_ID]: "20 жов",
        other_date: OTHER_DATE_LABEL,
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: [DATE_ID, "other_date"],
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

const availabilityContext = {
  serviceId: CONSULTATION_SERVICE_ID,
  stepMinutes: 30,
  days: [
    {
      date: DATE_ID,
      dayLabel: "20 жов",
      slots: [
        {
          id: SLOT_ID,
          label: "11:00",
          dateStart: "2026-10-20T11:00:00+03:00",
          dateEnd: "2026-10-20T11:30:00+03:00",
        },
      ],
    },
  ],
};

describe("createBookingDecideNode chip label ingress", () => {
  it("maps reply-keyboard 11:00 to the slot id when inboundChoiceId is null", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for a matched chip");
      }),
    });
    const update = await node({
      messages: [new HumanMessage("11:00")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.reason).not.toBe("unknown_choice");
    expect(update.bookingDecision?.reason).not.toBe("needs_interpreter");
    expect(update.bookingDraft?.selectedSlot?.dateStart).toBe(
      "2026-10-20T11:00:00+03:00",
    );
  });

  it("maps a date label and Інша дата to their choice ids", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for a matched chip");
      }),
    });

    const dateUpdate = await node({
      messages: [new HumanMessage("20 жов")],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: DATE_ID, label: "20 жов" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(dateUpdate.bookingDraft?.selectedDate).toBe(DATE_ID);
    expect(dateUpdate.bookingDecision?.card?.kind).toBe("time_select");

    const otherUpdate = await node({
      messages: [new HumanMessage(OTHER_DATE_LABEL)],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: DATE_ID, label: "20 жов" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(otherUpdate.bookingDecision?.pendingEffect?.effect.kind).toBe(
      "present_availability",
    );
  });

  it("does not invent callbackChoiceId for unmatched prose on an open time card", async () => {
    let sawCallback: string | undefined;
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async (input) => {
        sawCallback = input.callbackChoiceId;
        return {};
      }),
    });
    await node({
      messages: [new HumanMessage("а скільки коштує?")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(sawCallback).toBeUndefined();
  });

  it("prefers inboundChoiceId over a conflicting label match", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for an inbound choice id");
      }),
    });
    const update = await node({
      // Label would match SLOT_ID; inbound must win.
      messages: [new HumanMessage("11:00")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: "other_date",
    } as never);

    expect(update.bookingDraft?.selectedSlot).toBeFalsy();
    expect(update.bookingDecision?.pendingEffect?.effect.kind).toBe(
      "present_availability",
    );
  });
});



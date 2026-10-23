import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import { hasPendingToolCalls } from "../../tool-routing.js";
import { createBookingDecideNode } from "../booking-decide-nodes.js";
import { createBookingRespondNode } from "../booking-respond.js";
import { stampBookingEffect } from "../stamp-booking-effect.js";

const draftPendingConsult = (): BookingDraft => {
  const draft = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: false,
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

describe("date chips after service accept", () => {
  it("stamps present_availability with direction (not queryKind)", () => {
    const stamped = stampBookingEffect({
      id: "eff_1_present_availability",
      expectedRevision: 1,
      effect: { kind: "present_availability", queryKind: "nearest" },
      status: "prepared",
    });
    expect(stamped).not.toBeNull();
    expect(stamped!.args.direction).toBe("nearest");
    expect(stamped!.args.queryKind).toBeUndefined();
    expect(stamped!.args.__bookingEffectStamp).toBe("bookingEffectV1");
  });

  it("stamps earlier with beforeDate from the open snapshot first day", () => {
    const stamped = stampBookingEffect(
      {
        id: "eff_12_present_availability",
        expectedRevision: 12,
        effect: {
          kind: "present_availability",
          queryKind: "earlier",
          durationMinutes: 30,
        },
        status: "prepared",
      },
      {
        availabilityContext: {
          days: [
            {
              date: "2026-10-22",
              dayLabel: "22 жовт",
              slots: [{
                id: "s1",
                label: "11:00",
                dateStart: "2026-10-22T11:00:00",
                dateEnd: "2026-10-22T11:30:00",
              }],
            },
            {
              date: "2026-10-23",
              dayLabel: "23 жовт",
              slots: [{
                id: "s2",
                label: "12:00",
                dateStart: "2026-10-23T12:00:00",
                dateEnd: "2026-10-23T12:30:00",
              }],
            },
            {
              date: "2026-10-24",
              dayLabel: "24 жовт",
              slots: [{
                id: "s3",
                label: "13:00",
                dateStart: "2026-10-24T13:00:00",
                dateEnd: "2026-10-24T13:30:00",
              }],
            },
          ],
          stepMinutes: 30,
        },
        scope: { durationMinutes: 30 },
        availabilityPagedThisTurn: false,
      },
    );
    expect(stamped).not.toBeNull();
    expect(stamped!.args).toMatchObject({
      direction: "earlier",
      beforeDate: "2026-10-22",
      durationMinutes: 30,
      __bookingEffectStamp: "bookingEffectV1",
    });
    expect(stamped!.args.queryKind).toBeUndefined();
  });

  it("Overwrite-clears stale ToolMessages so a recycled effect id stays pending", async () => {
    const staleId = "eff_1_present_availability";
    const node = createBookingDecideNode({
      interpretTurn: async () => {
        throw new Error("decide must not re-interpret");
      },
    });

    const update = await node({
      messages: [new HumanMessage("Так")],
      // Prior turn left a ToolMessage whose id matches the next effect id.
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: staleId,
            name: "present_availability_slots",
            args: {},
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ days: [], stepMinutes: 30 }),
          tool_call_id: staleId,
          name: "present_availability_slots",
        }),
      ],
      bookingDraft: draftPendingConsult(),
      understoodTurn: { serviceIntent: { kind: "confirm_pending_service" } },
      pendingInteraction: {
        kind: "service_confirm",
        serviceId: CONSULTATION_SERVICE_ID,
        choices: [
          { id: "offer_accept", label: "Так" },
          { id: "offer_choose_other", label: "Обрати іншу процедуру" },
        ],
      },
      availabilityContext: null,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.tag).toBe("effect");
    expect(update.bookingDecision?.intent).toBe("present_dates");
    expect(update.bookingDecision?.card).toBeNull();
    expect(update.agentMessages).toBeInstanceOf(Overwrite);

    const tape = (update.agentMessages as Overwrite<unknown[]>).value as unknown[];
    expect(tape).toHaveLength(1);
    expect(hasPendingToolCalls(tape as never)).toBe(true);
    // Stale fulfilled id must not be on the tape.
    expect(
      tape.some((m) => m instanceof ToolMessage && m.tool_call_id === staleId),
    ).toBe(false);
  });

  it("parses single-day {date,slots} availability ToolMessages into a slots outcome", async () => {
    const effectId = "eff_2_present_availability";
    let draft: BookingDraft | null = reduceBookingDraft(draftPendingConsult(), {
      type: "service_accepted",
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: effectId,
        expectedRevision: 2,
        effect: { kind: "present_availability", queryKind: "nearest" },
        status: "executing",
      },
    });
    if (draft == null) {
      throw new Error("expected draft");
    }

    const node = createBookingDecideNode();
    const update = await node({
      messages: [new HumanMessage("Так")],
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: effectId,
            name: "present_availability_slots",
            args: { direction: "nearest" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({
            date: "2026-10-21",
            dayLabel: "21 жов",
            slots: [
              {
                id: "2026-10-21T1000",
                label: "10:00",
                dateStart: "2026-10-21T10:00:00+03:00",
                dateEnd: "2026-10-21T10:30:00+03:00",
              },
            ],
            stepMinutes: 30,
          }),
          tool_call_id: effectId,
          name: "present_availability_slots",
        }),
      ],
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: {
        serviceId: CONSULTATION_SERVICE_ID,
        stepMinutes: 30,
        days: [
          {
            date: "2026-10-21",
            dayLabel: "21 жов",
            slots: [
              {
                id: "2026-10-21T1000",
                label: "10:00",
                dateStart: "2026-10-21T10:00:00+03:00",
                dateEnd: "2026-10-21T10:30:00+03:00",
              },
            ],
          },
        ],
      },
      inboundChoiceId: null,
    } as never);

    // Single-day payload without selectedDate → date_select chip for that day.
    expect(update.bookingDecision?.card?.kind).toBe("date_select");
    expect(update.bookingDecision?.intent).toBe("present_dates");
    expect(update.bookingDecision?.card).toMatchObject({
      kind: "date_select",
      choiceIds: expect.arrayContaining(["2026-10-21"]),
    });
  });

  it("respond refuses open effect decisions (no empty date keyboard)", async () => {
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({
          invoke: async () => ({
            text: "Будь ласка, оберіть зручну для вас дату візиту.",
          }),
        }),
      } as never,
    });
    const update = await node({
      bookingDecision: {
        tag: "effect",
        intent: "present_dates",
        facts: {},
        card: null,
        pendingEffect: {
          id: "eff_1_present_availability",
          expectedRevision: 1,
          effect: { kind: "present_availability", queryKind: "nearest" },
          status: "prepared",
        },
      },
      bookingDraft: draftPendingConsult(),
    } as never);

    expect(update.lastHandoff?.replyText).not.toMatch(/дат/i);
    expect(update.lastHandoff?.replyButtons ?? []).toEqual([]);
  });

  it("fail-closes a missing ToolMessage instead of re-interpreting Так", async () => {
    const effectId = "eff_2_present_availability";
    let draft: BookingDraft | null = reduceBookingDraft(draftPendingConsult(), {
      type: "service_accepted",
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: effectId,
        expectedRevision: 2,
        effect: { kind: "present_availability", queryKind: "nearest" },
        status: "executing",
      },
    });
    if (draft == null) {
      throw new Error("expected draft");
    }

    const node = createBookingDecideNode({
      interpretTurn: async () => {
        throw new Error("must not re-interpret patient text while effect is open");
      },
    });
    const update = await node({
      messages: [new HumanMessage("Так")],
      // Tools returned nothing matching the pending effect id.
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "other",
            name: "list_services",
            args: {},
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ list: [] }),
          tool_call_id: "other",
          name: "list_services",
        }),
      ],
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: null,
      inboundChoiceId: null,
    } as never);

    // Availability error → fail closed (no same-hop remint of present_availability).
    expect(update.bookingDecision?.tag).toBe("ask");
    expect(update.bookingDecision?.intent).toBe("clarification");
    expect(update.bookingDecision?.reason).toBe("availability_failed");
    expect(update.bookingDecision?.pendingEffect).toBeUndefined();
  });
});

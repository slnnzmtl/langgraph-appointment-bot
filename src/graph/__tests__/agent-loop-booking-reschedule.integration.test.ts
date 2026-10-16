import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createBookingPrepareNode,
  createBookingFinalizeNode,
  advanceBookingNoteStep,
  createAgentCommandPrepareNode,
  createAgentLlmNode,
  createAgentMutationFinalizeNode,
  createAgentToolsNode,
  availabilityOfferFromToolTurn,
  formatAvailabilityDateOffer,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  resolveAvailabilityOffer,
  routeAfterAgentLlm,
} from "../agent-loop/index.js";
import {
  BOOKING_AWAITING_CONFIRM_UK,
  BOOKING_NOTE_QUESTION_UK,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  SERVICE_OR_NOTE_KEEP_LABEL_UK,
  SERVICE_OR_NOTE_SWITCH_LABEL_UK,
} from "../../shared/clinic-constants.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import type { ClinicState } from "../state.js";
import {
  availabilityMatchesBooking,
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import type { BookingDraft } from "../booking-draft.js";
import { type ClinicAgentDefinition } from "../types.js";

import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  lastToolCallFromPrepare,
  makeListedMeetings,
  ownedContactContext,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";


/**
 * Legacy integration scenarios. Obsolete skipped cases removed in DDD-267
 * (planner-owned mutations, tools-protocol stamp gate, availability cache paging).
 */
describe("booking reschedule integration", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books appointments",
    systemPrompt: "book",
    maxSteps: 8,
  };

  const snapshot: AvailabilityContext = {
    days: [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "a",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          },
          {
            id: "b",
            label: "15:00",
            dateStart: "2026-09-10T15:00:00",
            dateEnd: "2026-09-10T15:30:00",
          },
        ],
      },
    ],
    stepMinutes: 30,
    startIntervalMinutes: 30,
  };

  /** Availability coerce/finalize tests need an accepted create service (or reschedule target). */
  const acceptedCreateDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft =>
    canonicalBookingDraft({
      phase: "date",
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
      contactId: null,
      serviceAcceptance: {
        status: "accepted",
        service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      },
      ...overrides,
    });

  const availabilityClinicState = (overrides: Partial<ClinicState> = {}): ClinicState =>
    clinicState({
      bookingDraft: acceptedCreateDraft(),
      ...overrides,
    });

  it("starts a direct reschedule with a fresh nearest search", async () => {
    const prepare = createBookingPrepareNode();
    const rescheduleDraft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: makeListedMeetings().meetings[0]!,
    });
    const seeded = await prepare(
      availabilityClinicState({
        messages: [new HumanMessage("Перенести")],
        bookingContext: makeListedMeetings(),
        bookingDraft: rescheduleDraft,
      }),
    );
    expect(unwrapCommandUpdate(seeded).bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-1" },
      selectedDate: null,
      selectedSlot: null,
    });

    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Перенести")],
        bookingContext: makeListedMeetings(),
        bookingDraft: unwrapCommandUpdate(seeded).bookingDraft,
        agentMessages: (unwrapCommandUpdate(seeded).agentMessages as Overwrite<AIMessage[]>).value,
      }),
    );
    const call = ((unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "nearest",
        durationMinutes: 30,
        excludeMeetingIds: ["m-1"],
        forceRefresh: true,
      },
    });
  });

  it("resolves date and time from one reschedule message and proceeds from the CRM slot", async () => {
    const message = new HumanMessage("Перенеси мій запис на 2026-10-16 о 14:00");
    const base = availabilityClinicState({
      messages: [message],
      bookingContext: makeListedMeetings(),
      bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: makeListedMeetings().meetings[0]!,
      }),
    });
    const prepare = createBookingPrepareNode();
    const seeded = await prepare(base);
    expect(unwrapCommandUpdate(seeded).bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-1" },
      selectedDate: "2026-10-16",
      requestedTime: { value: "14:00", status: "pending" },
      selectedSlot: null,
    });

    const preparedState = availabilityClinicState({
      ...base,
      bookingDraft: unwrapCommandUpdate(seeded).bookingDraft,
      agentMessages: (unwrapCommandUpdate(seeded).agentMessages as Overwrite<AIMessage[]>).value,
    });
    const commandPrepare = createAgentCommandPrepareNode();
    const lookup = await commandPrepare(preparedState);
    const lookupCall = ((unwrapCommandUpdate(lookup).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(lookupCall).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "exact",
        date: "2026-10-16",
        durationMinutes: 30,
        excludeMeetingIds: ["m-1"],
        forceRefresh: true,
      },
    });

    const invoked: Record<string, unknown>[] = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({
          days: [{
            date: "2026-10-16",
            slots: [{
              id: "slot-14",
              label: "14:00",
              dateStart: "2026-10-16T14:00:00",
              dateEnd: "2026-10-16T14:30:00",
            }],
          }],
          stepMinutes: 30,
          excludeMeetingIds: ["m-1"],
          query: { kind: "exact", date: "2026-10-16", coverageComplete: true },
        });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          date: z.string().optional(),
          durationMinutes: z.number().optional(),
          excludeMeetingIds: z.array(z.string()).optional(),
          forceRefresh: z.boolean().optional(),
        }),
      },
    );
    const toolsUpdate = await createAgentToolsNode([slotsTool], "booking")(
      availabilityClinicState({
        ...preparedState,
        bookingDraft: unwrapCommandUpdate(seeded).bookingDraft,
        agentMessages: (unwrapCommandUpdate(lookup).agentMessages as Overwrite<AIMessage[]>).value,
      }),
      { configurable: {} },
    );
    expect(invoked[0]).toMatchObject({
      direction: "exact",
      date: "2026-10-16",
      durationMinutes: 30,
      excludeMeetingIds: ["m-1"],
      forceRefresh: true,
    });
    expect(toolsUpdate.bookingDraft).toMatchObject({
      selectedDate: "2026-10-16",
      selectedSlot: {
        dateStart: "2026-10-16T14:00:00",
        dateEnd: "2026-10-16T14:30:00",
      },
      requestedTime: null,
      phase: "ready",
    });

    const mutation = await commandPrepare(
      availabilityClinicState({
        ...preparedState,
        bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
        agentMessages: toolsUpdate.agentMessages as never,
      }),
    );
    const mutationCall = ((unwrapCommandUpdate(mutation).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(mutationCall).toMatchObject({
      name: "reschedule_meeting",
      args: {
        meetingId: "m-1",
        dateStart: "2026-10-16T14:00:00",
        dateEnd: "2026-10-16T14:30:00",
      },
    });
  });

  it("keeps the CRM visit duration for a 60-minute reschedule end to end", async () => {
    const sixtyMinuteMeeting = {
      id: "m-60",
      name: "Пілінг поверхневий",
      dateStart: "2026-10-26T11:00:00",
      dateEnd: "2026-10-26T12:00:00",
    };
    const message = new HumanMessage("Перенеси мій запис на 2026-10-23 о 11:00");
    const base = clinicState({
      messages: [message],
      bookingContext: {
        meetings: [sixtyMinuteMeeting],
        dateFrom: "2026-10-10",
      },
      bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: sixtyMinuteMeeting,
      }),
    });
    const prepare = createBookingPrepareNode();
    const seeded = await prepare(base);
    expect(unwrapCommandUpdate(seeded).bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-60" },
      selectedDate: "2026-10-23",
      requestedTime: { value: "11:00", status: "pending" },
    });

    const preparedState = clinicState({
      ...base,
      bookingDraft: unwrapCommandUpdate(seeded).bookingDraft,
      agentMessages: (unwrapCommandUpdate(seeded).agentMessages as Overwrite<AIMessage[]>).value,
    });
    const commandPrepare = createAgentCommandPrepareNode();
    const lookup = await commandPrepare(preparedState);
    const lookupCall = ((unwrapCommandUpdate(lookup).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(lookupCall).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "exact",
        date: "2026-10-23",
        durationMinutes: 60,
        excludeMeetingIds: ["m-60"],
        forceRefresh: true,
      },
    });

    const staleThirtyMinuteSnapshot: AvailabilityContext = {
      days: [{
        date: "2026-10-23",
        slots: [{
          id: "stale",
          label: "11:00",
          dateStart: "2026-10-23T11:00:00",
          dateEnd: "2026-10-23T11:30:00",
        }],
      }],
      stepMinutes: 30,
      startIntervalMinutes: 30,
      excludeMeetingIds: ["m-60"],
    };
    expect(availabilityMatchesBooking(
      staleThirtyMinuteSnapshot,
      unwrapCommandUpdate(seeded).bookingDraft as BookingDraft,
    )).toBe(false);

    const invoked: Record<string, unknown>[] = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({
          days: [{
            date: "2026-10-23",
            slots: [{
              id: "slot-11",
              label: "11:00",
              dateStart: "2026-10-23T11:00:00",
              dateEnd: "2026-10-23T12:00:00",
            }],
          }],
          stepMinutes: 60,
          excludeMeetingIds: ["m-60"],
          query: { kind: "exact", date: "2026-10-23", coverageComplete: true },
        });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          date: z.string().optional(),
          durationMinutes: z.number().optional(),
          excludeMeetingIds: z.array(z.string()).optional(),
          forceRefresh: z.boolean().optional(),
        }),
      },
    );
    const toolsUpdate = await createAgentToolsNode([slotsTool], "booking")(
      clinicState({
        ...preparedState,
        bookingDraft: unwrapCommandUpdate(seeded).bookingDraft,
        availabilityContext: staleThirtyMinuteSnapshot,
        agentMessages: (unwrapCommandUpdate(lookup).agentMessages as Overwrite<AIMessage[]>).value,
      }),
      { configurable: {} },
    );
    expect(invoked[0]).toMatchObject({
      direction: "exact",
      date: "2026-10-23",
      durationMinutes: 60,
      excludeMeetingIds: ["m-60"],
    });
    expect(toolsUpdate.bookingDraft).toMatchObject({
      selectedDate: "2026-10-23",
      selectedSlot: {
        dateStart: "2026-10-23T11:00:00",
        dateEnd: "2026-10-23T12:00:00",
      },
      phase: "ready",
    });

    const mutation = await commandPrepare(
      clinicState({
        ...preparedState,
        bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
        agentMessages: toolsUpdate.agentMessages as never,
        availabilityContext: toolsUpdate.availabilityContext as AvailabilityContext,
      }),
    );
    const mutationCall = ((unwrapCommandUpdate(mutation).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    // Revalidation runs before the mutation when the snapshot still needs a fresh check.
    if (mutationCall?.name === "present_availability_slots") {
      expect(mutationCall.args).toMatchObject({
        direction: "exact",
        date: "2026-10-23",
        durationMinutes: 60,
        excludeMeetingIds: ["m-60"],
        forceRefresh: true,
      });
      const revalidated = await createAgentToolsNode([slotsTool], "booking")(
        clinicState({
          ...preparedState,
          bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
          agentMessages: (unwrapCommandUpdate(mutation).agentMessages as Overwrite<AIMessage[]>).value,
          availabilityContext: toolsUpdate.availabilityContext as AvailabilityContext,
        }),
        { configurable: {} },
      );
      const afterRevalidate = await commandPrepare(
        clinicState({
          ...preparedState,
          bookingDraft: revalidated.bookingDraft as BookingDraft,
          agentMessages: revalidated.agentMessages as never,
          availabilityContext: revalidated.availabilityContext as AvailabilityContext,
        }),
      );
      const rescheduleCall = (
        (unwrapCommandUpdate(afterRevalidate).agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage
      ).tool_calls?.[0];
      expect(rescheduleCall).toMatchObject({
        name: "reschedule_meeting",
        args: {
          meetingId: "m-60",
          dateStart: "2026-10-23T11:00:00",
          dateEnd: "2026-10-23T12:00:00",
        },
      });
    } else {
      expect(mutationCall).toMatchObject({
        name: "reschedule_meeting",
        args: {
          meetingId: "m-60",
          dateStart: "2026-10-23T11:00:00",
          dateEnd: "2026-10-23T12:00:00",
        },
      });
    }
  });

  it("records a reschedule time without entering the note step", async () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: { id: "m-1" },
      }),
      { type: "date_selected", date: "2026-09-10" },
    );
    const update = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("14:00")],
        bookingDraft: draft,
        availabilityContext: {
          ...snapshot,
          excludeMeetingIds: ["m-1"],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(unwrapCommandUpdate(update).bookingDraft?.phase).toBe("ready");
    expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("unasked");
  });

  it("reports an unavailable requested time and offers the remaining CRM slots", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: { id: "m-1" },
      }),
      { type: "schedule_requested", date: "2026-09-10", preferredTime: "14:00" },
    );
    const unavailable = reduceBookingDraft(draft, { type: "requested_time_unavailable" });
    const remainingAvailability: AvailabilityContext = {
      days: [{
        ...snapshot.days[0]!,
        slots: [snapshot.days[0]!.slots[1]!],
      }],
      stepMinutes: 30,
      startIntervalMinutes: 30,
    };
    const update = await finalize(
      availabilityClinicState({
        bookingDraft: unavailable,
        availabilityContext: remainingAvailability,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: remainingAvailability.days,
              stepMinutes: 30,
              excludeMeetingIds: ["m-1"],
              query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage("На жаль, цього часу немає."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("о 14:00");
    expect(update.lastHandoff?.replyText).toContain("немає вільного часу");
    expect(update.lastHandoff?.replyText).toContain("15:00");
    expect(update.lastHandoff?.replyButtons).toContain("15:00");
  });

  it("keeps consultation consent and the selected slot through note skip", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const offer = await finalize(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );
    expect(offer.pendingInteraction?.kind).toBe("service_confirm");
    const prepare = createBookingPrepareNode();
    const accepted = await prepare(
      availabilityClinicState({
        messages: [
          new HumanMessage("Записатись"),
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("Так"),
        ],
        bookingDraft: offer.bookingDraft,
        pendingInteraction: offer.pendingInteraction,
        availabilityContext: snapshot,
      }),
    );
    expect(accepted.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    // After accept, prepare queues note orch for DATE/TIME free text — slot
    // matching still lives in advanceBookingNoteStep (snapshot clock).
    const picked = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("14:00")],
        bookingDraft: accepted.bookingDraft,
        pendingInteraction: null,
        availabilityContext: snapshot,
      }),
    );

    expect(picked.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(picked.bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(picked.bookingDraft?.note.status).toBe("awaiting");

    const { orchestrateBookingNoteTurn } = await import("../booking-note-orchestrator.js");
    const { openVisitNoteInteraction } = await import("../booking-session.js");
    const skipped = await orchestrateBookingNoteTurn({
      patientText: "Продовжити без коментаря",
      bookingDraft: picked.bookingDraft ?? null,
      pendingInteraction: openVisitNoteInteraction(),
      classify: async () => ({ kind: "note_skipped" }),
      resolveServiceChange: async () => ({ type: "service_unresolved" }),
    });

    expect(skipped.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(skipped.bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(skipped.bookingDraft?.note.status).toBe("skipped");
  });

});



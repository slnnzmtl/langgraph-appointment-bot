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
describe("stabilize booking flow (DDD-48/49/50/51)", () => {
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

  it("checkpoints a normalized mutation command before the tools node", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const draft = {
      version: 3,
      mode: "create" as const,
      phase: "details" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" as const },
      },
      availability: null,
      selectedDate: "2026-09-10",
      selectedSlot: {
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
        label: "14:00",
      },
      note: { status: "skipped" as const },
      contactId: "c-1",
      pendingCommand: null,
    };
    const update = await commandPrepare(
      availabilityClinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-1",
            firstName: "Ada",
            lastName: "Lovelace",
            phoneNumber: "+380501112233",
            missingFields: [],
          }],
        },
        bookingDraft: draft,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: [{
                date: "2026-09-10",
                slots: [{
                  id: "slot-14",
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
              }],
              stepMinutes: 30,
              query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand).toMatchObject({
      action: "create",
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
  });

  it("prepares a create call from a ready draft without an LLM mutation call", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-1",
            firstName: "Ada",
            lastName: "Lovelace",
            phoneNumber: "+380501112233",
            missingFields: [],
          }],
        },
        bookingDraft: {
          version: 4,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
          },
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: null,
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: [{
                date: "2026-09-10",
                slots: [{
                  id: "slot-14",
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
              }],
              stepMinutes: 30,
              query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
        ],
      }),
    );

    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const message = messages.at(-1)!;
    expect(message.tool_calls?.[0]).toMatchObject({
      name: "create_meeting",
      args: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(unwrapCommandUpdate(update).bookingDraft?.phase).toBe("confirming");
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand).toMatchObject({
      action: "create",
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
      },
    });
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand).not.toHaveProperty("idempotencyKey");
  });

  it("does not replay a frozen create from awaitingConfirmation (affirm uses confirmed resume)", async () => {
    // NL affirm is classified in the adapter against mutation_confirm and
    // resumes { confirmed: true }. awaitingConfirmation means chat-other only.
    const commandPrepare = createAgentCommandPrepareNode();
    const originalPayload = {
      name: "Видалення бородавки 1 шт - Test Patient",
      dateStart: "2026-10-10T11:00:00",
      dateEnd: "2026-10-10T11:30:00",
      contactId: "c-1",
      serviceId: "svc-wart",
      confirmMessage: "Підтвердити запис на 11:00?",
      description: "Видалення бородавки на ступні у сина, 11 років.",
    };
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Так, підтверджую!")],
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        bookingDraft: {
          ...canonicalBookingDraft({ contactId: "c-1" }),
          phase: "confirming",
          pendingCommand: { action: "create", payload: originalPayload },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "Так, підтверджую!",
              draft: {
                command: {
                  action: "create",
                  payload: {
                    name: originalPayload.name,
                    dateStart: originalPayload.dateStart,
                    dateEnd: originalPayload.dateEnd,
                    parentId: "c-1",
                  },
                },
              },
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(update.agentMessages).toBeUndefined();
  });

  it("does not replay a pending mutation for a non-affirmative chat reply", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("А можна інший час?")],
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: { serviceId: "svc-1", dateStart: "2026-09-10T14:00:00" },
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(update.agentMessages).toBeUndefined();
  });

  it("re-arms cancel HITL after cancel chat-other once the model answered", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const state = availabilityClinicState({
      messages: [new HumanMessage("скільки коштує консультація")],
      bookingContext: makeListedMeetings(),
      bookingDraft: {
        ...createEmptyBookingDraft("create"),
        phase: "confirming",
        pendingCommand: null,
      },
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "cancel",
        choices: [
          { id: "confirm", label: "✅" },
          { id: "decline", label: "❌" },
        ],
      },
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "скільки коштує консультація",
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-1",
        }),
        new AIMessage("Вартість первинної консультації становить 300 грн."),
      ],
    });

    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const update = await commandPrepare(state);
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    expect(lastAi).toBeInstanceOf(AIMessage);
    expect(lastAi?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: expect.objectContaining({
        meetingId: "m-1",
        confirmMessage: expect.stringContaining("Скасувати"),
      }),
    });
    expect(lastAi?.tool_calls?.[0]?.args).not.toHaveProperty("confirmationGiven");
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
    expect(unwrapCommandUpdate(update).lastHandoff?.replyText).toBe(
      "Вартість первинної консультації становить 300 грн.",
    );
  });

  it("re-arms cancel HITL from awaitingConfirmation draft when bookingContext is empty", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const state = availabilityClinicState({
      messages: [new HumanMessage("Скільки коштує консультація?")],
      bookingContext: null,
      bookingDraft: {
        ...createEmptyBookingDraft("create"),
        phase: "confirming",
        pendingCommand: null,
      },
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "cancel",
        choices: [
          { id: "confirm", label: "✅" },
          { id: "decline", label: "❌" },
        ],
      },
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "Скільки коштує консультація?",
            draft: {
              confirmMessage: "Скасувати цей візит?",
              command: {
                action: "cancel",
                payload: { meetingId: "m-frozen", status: "Not Held" },
              },
            },
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-frozen-1",
        }),
        new AIMessage("Вартість первинної консультації становить 300 грн."),
      ],
    });

    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const update = await commandPrepare(state);
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    expect(lastAi?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: expect.objectContaining({ meetingId: "m-frozen" }),
    });
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
  });

  it("re-arms cancel HITL when pendingCommand is the CRM write payload", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const state = availabilityClinicState({
      messages: [new HumanMessage("Скільки коштує консультація?")],
      bookingContext: makeListedMeetings(),
      bookingDraft: {
        ...createEmptyBookingDraft("create"),
        phase: "confirming",
        pendingCommand: {
          action: "cancel",
          payload: { meetingId: "m-crm", status: "Not Held" },
        },
      },
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "cancel",
        choices: [
          { id: "confirm", label: "✅" },
          { id: "decline", label: "❌" },
        ],
      },
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "Скільки коштує консультація?",
            draft: {
              confirmMessage: "Скасувати цей візит?",
              name: "Консультація",
              dateStart: "2026-10-10T13:30:00",
              dateEnd: "2026-10-10T14:00:00",
              command: {
                action: "cancel",
                payload: { meetingId: "m-crm", status: "Not Held" },
              },
            },
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-crm-1",
        }),
        new AIMessage("Вартість первинної консультації становить 300 грн."),
      ],
    });

    const update = await commandPrepare(state);
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    const args = lastAi?.tool_calls?.[0]?.args as Record<string, unknown> | undefined;
    expect(lastAi?.tool_calls?.[0]?.name).toBe("cancel_meeting");
    expect(args).toMatchObject({
      meetingId: "m-crm",
      confirmMessage: expect.stringContaining("Скасувати"),
    });
    expect(args).not.toHaveProperty("status");
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand?.payload).not.toHaveProperty("status");
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand?.payload).toMatchObject({
      meetingId: "m-crm",
      confirmMessage: expect.stringContaining("Скасувати"),
    });
  });

  it("re-arms cancel HITL when visit_select is still open after cancel chat-other", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const state = availabilityClinicState({
      messages: [new HumanMessage("Скільки коштує консультація?")],
      bookingContext: null,
      bookingDraft: {
        ...createEmptyBookingDraft("create"),
        phase: "confirming",
        pendingCommand: null,
      },
      pendingInteraction: {
        kind: "visit_select",
        stage: "action",
        meetings: [{ id: "m-visit", name: "Візит", dateStart: "2026-08-17T11:00:00" }],
        choices: [
          { id: "reschedule", label: "Перенести" },
          { id: "cancel", label: "Скасувати" },
          { id: "decline", label: "Ні, дякую" },
        ],
      },
      agentMessages: [
        runtimeToolAi([{
            id: "cancel-visit-1",
            name: "cancel_meeting",
            args: { meetingId: "m-visit", confirmMessage: "Скасувати?" },
            type: "tool_call",
          }]),
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "Скільки коштує консультація?",
            draft: {
              command: {
                action: "cancel",
                payload: { meetingId: "m-visit", status: "Not Held" },
              },
            },
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-visit-1",
        }),
        new AIMessage("Вартість первинної консультації — 300 грн."),
      ],
    });

    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const update = await commandPrepare(state);
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    expect(lastAi?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: expect.objectContaining({ meetingId: "m-visit" }),
    });
  });

  it("does not re-arm create chat-other as a mutation", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("скільки коштує консультація")],
        bookingContext: makeListedMeetings(),
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: null,
        },
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "скільки коштує консультація",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Вартість первинної консультації становить 300 грн."),
        ],
      }),
    );
    expect(update.agentMessages).toBeUndefined();
    expect(update.lastHandoff).toBeUndefined();
  });

  it.each([undefined, true])(
    "rejects a mutation call after a non-affirmative chat reply (confirmationGiven=%s)",
    async (confirmationGiven) => {
      const state = availabilityClinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              contactId: "contact-1",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            },
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage({
            content: "Не виконую дію без підтвердження.",
            tool_calls: [{
              id: "replay-1",
              name: "create_meeting",
              args: confirmationGiven === undefined ? {} : { confirmationGiven },
              type: "tool_call",
            }],
          }),
        ],
      });

      expect(routeAfterAgentLlm(state, 8, "tools", "finalize", "prepare")).toBe("finalize");
      const finalized = await createBookingFinalizeNode(agent)(state);
      expect((finalized.messages as AIMessage[])[0]?.tool_calls).toHaveLength(0);
    },
  );

  it("invalidates a create slot when chat confirmation remains unresolved", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Звісно, підберемо інший час."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("does not drop the slot when keep/switch already cleared the confirm command", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          note: { status: "skipped" },
          pendingCommand: null,
        }),
        pendingInteraction: {
          kind: "service_or_note",
          currentService: { id: CONSULTATION_SERVICE_ID, name: "Консультація" },
          noteCandidate: "запиши на ботокс",
          choices: [
            { id: "keep_service", label: SERVICE_OR_NOTE_KEEP_LABEL_UK },
            { id: "switch_service", label: SERVICE_OR_NOTE_SWITCH_LABEL_UK },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на ботокс",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Ви обрали «Консультація»."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
    expect(update.lastHandoff?.replyButtons).toEqual([
      SERVICE_OR_NOTE_KEEP_LABEL_UK,
      SERVICE_OR_NOTE_SWITCH_LABEL_UK,
    ]);
  });

  it("finalize keeps keep/switch labels in text and on the keyboard", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          phase: "confirming",
          note: { status: "skipped" },
        }),
        pendingInteraction: {
          kind: "service_or_note",
          currentService: { id: CONSULTATION_SERVICE_ID, name: "Консультація" },
          noteCandidate: "запиши на ботокс",
          choices: [
            { id: "keep_service", label: SERVICE_OR_NOTE_KEEP_LABEL_UK },
            { id: "switch_service", label: SERVICE_OR_NOTE_SWITCH_LABEL_UK },
          ],
        },
        agentMessages: [
          new AIMessage("Ви обрали «Консультація». Ваше повідомлення також може означати зміну послуги."),
        ],
      }),
    );
    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain(`• ${SERVICE_OR_NOTE_KEEP_LABEL_UK}`);
    expect(text).toContain(`• ${SERVICE_OR_NOTE_SWITCH_LABEL_UK}`);
    expect(update.lastHandoff?.replyButtons).toEqual([
      SERVICE_OR_NOTE_KEEP_LABEL_UK,
      SERVICE_OR_NOTE_SWITCH_LABEL_UK,
    ]);
  });

  const oct20SlotsTool = () =>
    new ToolMessage({
      content: JSON.stringify({
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [{
          id: "slot-20-12",
          label: "12:00",
          dateStart: "2026-10-20T12:00:00",
          dateEnd: "2026-10-20T12:30:00",
        }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2026-10-20",
          rangeFrom: "2026-10-20",
          rangeThrough: "2026-10-20",
          coverageComplete: true,
        },
      }),
      name: "present_availability_slots",
      tool_call_id: "slots-20",
    });

  const oct22SlotsTool = () =>
    new ToolMessage({
      content: JSON.stringify({
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [{
          id: "slot-22-11",
          label: "11:00",
          dateStart: "2026-10-22T11:00:00",
          dateEnd: "2026-10-22T11:30:00",
        }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2026-10-22",
          rangeFrom: "2026-10-22",
          rangeThrough: "2026-10-22",
          coverageComplete: true,
        },
      }),
      name: "present_availability_slots",
      tool_call_id: "slots-22",
    });

  it("ignores pre-HITL leftover slots for TIME overlay after unresolved confirmation", async () => {
    const leftover = [
      oct20SlotsTool(),
      new ToolMessage({
        content: JSON.stringify({
          awaitingConfirmation: true,
          userReply: "запиши на 22 жовтня",
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
      new AIMessage("Підберу вільні години на 22 жовтня."),
    ];
    expect(availabilityOfferFromToolTurn(leftover)).toBeNull();
    expect(resolveAvailabilityOffer(leftover, null, false)).toBeNull();
  });

  it("TIME-overlays only slots that ran after pending confirmation", async () => {
    const offer = availabilityOfferFromToolTurn([
      oct20SlotsTool(),
      new ToolMessage({
        content: JSON.stringify({
          awaitingConfirmation: true,
          userReply: "запиши на 22 жовтня",
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
      oct22SlotsTool(),
      new AIMessage("invented"),
    ]);
    expect(offer?.replyText).toContain("Вільні години на 22 жовтня");
    expect(offer?.replyText).not.toContain("20 жовтня");
  });

  it("does not rewrite HITL other-reply prose with leftover pre-confirm TIME", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        messages: [new HumanMessage("запиши на 22 жовтня")],
        contactContext: ownedContactContext(),
        bookingDraft: {
          ...canonicalBookingDraft({
            selectedDate: "2026-10-20",
            selectedSlot: {
              dateStart: "2026-10-20T12:00:00",
              dateEnd: "2026-10-20T12:30:00",
              label: "12:00",
            },
            phase: "confirming",
            note: { status: "answered", text: "акне" },
            pendingCommand: {
              action: "create",
              payload: {
                serviceId: "svc-1",
                dateStart: "2026-10-20T12:00:00",
                dateEnd: "2026-10-20T12:30:00",
              },
            },
          }),
        },
        agentMessages: [
          oct20SlotsTool(),
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на 22 жовтня",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Підберу вільні години на 22 жовтня."),
        ],
      }),
    );

    const reply = (update.lastHandoff as { replyText?: string } | null)?.replyText ?? "";
    // Pending confirmation is outcome-risk: runtime owns the reply (no model claim / no stale TIME).
    expect(reply).toBe(BOOKING_AWAITING_CONFIRM_UK);
    expect(reply).not.toContain("Вільні години на 20 жовтня");
    expect(update.lastHandoff?.replyButtons).toEqual([CONFIRM_YES_LABEL, CONFIRM_NO_LABEL]);
  });

  it("command_prepare injects post-HITL exact-date slots despite leftover pre-confirm slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00+03:00"));
    const commandPrepare = createAgentCommandPrepareNode();
    const draft = reduceBookingDraft(
      canonicalBookingDraft({
        selectedDate: "2026-10-20",
        selectedSlot: {
          dateStart: "2026-10-20T12:00:00",
          dateEnd: "2026-10-20T12:30:00",
          label: "12:00",
        },
        phase: "confirming",
        note: { status: "answered", value: "акне" },
        pendingCommand: null,
      }),
      { type: "schedule_requested", date: "2026-10-22" },
    );
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("запиши на 22 жовтня")],
        contactContext: ownedContactContext(),
        bookingDraft: draft,
        agentMessages: [
          oct20SlotsTool(),
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на 22 жовтня",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Підберу вільні години."),
        ],
      }),
    );
    vi.useRealTimers();

    // Create chat-other must not re-arm mutation; exact-date inject waits for a
    // later turn after slot invalidation (Path B).
    expect(update.agentMessages).toBeUndefined();
  });

  it("abandons a create draft after an explicit chat decline", async () => {
    // Adapter maps NL decline to { confirmed: false } → cancelled tool result.
    const finalize = createAgentMutationFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ cancelled: true, message: "Patient declined." }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    expect(update.lastHandoff?.replyText).toBe("Запис не було створено.");
  });

  it("invalidates a reschedule slot when chat confirmation remains unresolved", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        bookingDraft: {
          ...canonicalBookingDraft({
            mode: "reschedule",
            phase: "confirming",
            selectedDate: "2026-09-10",
            rescheduleTarget: { id: "meeting-1", name: "Процедура - Ada" },
            pendingCommand: {
              action: "reschedule",
              payload: { meetingId: "meeting-1", dateStart: "2026-09-10T14:00:00" },
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Покажіть інший час" }),
            name: "reschedule_meeting",
            tool_call_id: "reschedule-1",
          }),
          new AIMessage("Покажу інші вільні години."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      mode: "reschedule",
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      pendingCommand: null,
      rescheduleTarget: { id: "meeting-1" },
    });
  });

  it("clears direct cancellation confirmation state when chat confirmation remains unresolved", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        pendingCancellationPurpose: "direct",
        bookingDraft: {
          ...canonicalBookingDraft({
            phase: "confirming",
            serviceAcceptance: null,
            selectedDate: null,
            selectedSlot: null,
            note: { status: "unasked" },
            pendingCommand: {
              action: "cancel",
              payload: { meetingId: "meeting-1" },
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Ні, не скасовуйте" }),
            name: "cancel_meeting",
            tool_call_id: "cancel-1",
          }),
          new AIMessage("Добре, запис залишаю без змін."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      phase: "service",
      pendingCommand: null,
    });
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeNull();
  });

  it("terminates replacement cancellation when chat confirmation remains unresolved", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        pendingCancellationPurpose: "replacement",
        bookingDraft: {
          ...canonicalBookingDraft({
            mode: "replace",
            phase: "confirming",
            serviceAcceptance: null,
            selectedDate: null,
            selectedSlot: null,
            note: { status: "unasked" },
            pendingCommand: { action: "cancel", payload: { meetingId: "meeting-1" } },
            replacement: {
              meeting: { id: "meeting-1" },
              status: "cancelling",
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Покажіть інший варіант" }),
            name: "cancel_meeting",
            tool_call_id: "cancel-1",
          }),
          new AIMessage("Не скасовую поточний запис."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeNull();
  });

  it.each(["Так", "Cancel"])(
    "dispatches cancel_meeting for replacement consent (%s)",
    async (consent) => {
      const commandPrepare = createAgentCommandPrepareNode();
      const update = await commandPrepare(
        availabilityClinicState({
          messages: [new HumanMessage(consent)],
          bookingDraft: {
            version: 7,
            mode: "replace",
            phase: "confirming",
            serviceAcceptance: {
              status: "accepted",
              service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
            },
            availability: null,
            selectedDate: "2026-10-17",
            selectedSlot: {
              dateStart: "2026-10-17T11:30:00",
              dateEnd: "2026-10-17T12:00:00",
              label: "11:30",
            },
            note: { status: "skipped" },
            contactId: "c-1",
            pendingCommand: null,
            replacement: {
              meeting: { id: "existing-1", name: "Existing visit" },
              status: "offered",
              originalCommand: {
                action: "create",
                payload: { serviceId: CONSULTATION_SERVICE_ID },
                idempotencyKey: "create:replacement",
                expiresAt: Date.now() + 60_000,
              },
            },
          },
          agentMessages: [new AIMessage("Бажаєте скасувати поточний візит?")],
        }),
      );

      const prepared = unwrapCommandUpdate(update);
      const messages = (
        prepared.agentMessages instanceof Overwrite
          ? prepared.agentMessages.value
          : prepared.agentMessages
      ) as AIMessage[];
      expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
        name: "cancel_meeting",
        args: { meetingId: "existing-1" },
      });
      expect(unwrapCommandUpdate(update).bookingDraft?.replacement?.status).toBe("cancelling");
      expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand?.action).toBe("cancel");
    },
  );

  it("dispatches direct cancellation from the authoritative single-visit list", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingContext: makeListedMeetings(),
        bookingDraft: {
          ...createEmptyBookingDraft(),
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "m-1", confirmMessage: "Скасувати цей візит?" },
          },
        },
        agentMessages: [new AIMessage("Запис скасовано")],
      }),
    );

    const messages = (unwrapCommandUpdate(update).agentMessages instanceof Overwrite ? (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value : unwrapCommandUpdate(update).agentMessages as AIMessage[])
      ?? (update.agentMessages as AIMessage[]);
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: {
        meetingId: "m-1",
      },
    });
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand?.action).toBe("cancel");
    expect(unwrapCommandUpdate(update).bookingDraft?.phase).toBe("confirming");
  });

  it.each([
    "не скасовуйте",
    "як скасувати пізніше?",
    "я не хочу скасовувати",
  ])("does not synthesize cancel_meeting for non-imperative cancel phrasing (%s)", async (utterance) => {
    const state = availabilityClinicState({
      messages: [new HumanMessage(utterance)],
      bookingContext: makeListedMeetings(),
      // No active create ladder — only cancel synthesis is under test.
      bookingDraft: null,
      agentMessages: [new HumanMessage(utterance), new AIMessage("Добре")],
    });
    expect(
      routeAfterAgentLlm(
        state,
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).not.toBe("booking__command_prepare");

    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(state);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).not.toBe("mutation_confirm");
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand?.action).not.toBe("cancel");
  });

  it("reuses the cancellation command for explicit chat confirmation", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingDraft: {
          version: 8,
          mode: "replace",
          phase: "confirming",
          serviceAcceptance: null,
          availability: null,
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "existing-1", confirmationGiven: true },
          },
          replacement: {
            meeting: { id: "existing-1" },
            status: "cancelling",
          },
        },
        agentMessages: [new AIMessage("Підтвердьте скасування")],
      }),
    );
    const messages = (unwrapCommandUpdate(update).agentMessages instanceof Overwrite ? (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value : unwrapCommandUpdate(update).agentMessages as AIMessage[])
      ?? (update.agentMessages as AIMessage[]);
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: { meetingId: "existing-1", confirmationGiven: true },
    });
  });

  const bookingLlmReturning = (content: string) => {
    const invoke = vi.fn(async () => new AIMessage(content));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({}),
      },
    );
    return createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
  };

  it("matches clock-time picks from the availability snapshot", async () => {
    expect(matchAvailabilitySlot("14:00", snapshot)?.dateStart).toBe("2026-09-10T14:00:00");
    expect(matchAvailabilitySlot("14", snapshot)?.label).toBe("14:00");
    expect(matchAvailabilitySlot(OTHER_DATE_LABEL, snapshot)).toBeNull();
    expect(matchAvailabilitySlot("Інша", snapshot)).toBeNull();
  });

  it("matches a unique bare day only inside the trusted availability snapshot", async () => {
    const days: AvailabilityContext["days"] = [
      { ...snapshot.days[0]!, date: "2026-10-27", dayLabel: "27 жовтня (вівторок)" },
      { ...snapshot.days[0]!, date: "2026-10-28", dayLabel: "28 жовтня (середа)" },
    ];
    expect(matchAvailabilityDay("27", days)?.date).toBe("2026-10-27");
    expect(matchAvailabilityDay("29", days)).toBeNull();
    expect(matchAvailabilityDay("27", [
      days[0]!,
      { ...days[0]!, date: "2026-11-27", dayLabel: "27 листопада (п'ятниця)" },
    ])).toBeNull();
  });

  it("never resolves a repeated clock time from the wrong day", async () => {
    const multiDaySnapshot: AvailabilityContext = {
      days: [
        {
          date: "2026-10-13",
          dayLabel: "13 жовтня (вівторок)",
          slots: [{
            id: "old",
            label: "11:30",
            dateStart: "2026-10-13T11:30:00",
            dateEnd: "2026-10-13T12:00:00",
          }],
        },
        {
          date: "2026-10-17",
          dayLabel: "17 жовтня (субота)",
          slots: [{
            id: "chosen",
            label: "11:30",
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
          }],
        },
      ],
      stepMinutes: 30,
    };
    expect(matchAvailabilitySlot("11:30", multiDaySnapshot)).toBeNull();
    expect(matchAvailabilitySlot("11:30", multiDaySnapshot, "2026-10-17")?.dateStart)
      .toBe("2026-10-17T11:30:00");
  });

  it("treats a bare hour as TIME even when another offered date has that day number", async () => {
    const availability: AvailabilityContext = {
      days: [
        {
          date: "2026-10-27",
          slots: [{
            label: "11:00",
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
          }],
        },
        {
          date: "2026-11-11",
          slots: [{
            label: "12:00",
            dateStart: "2026-11-11T12:00:00",
            dateEnd: "2026-11-11T12:30:00",
          }],
        },
      ],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const update = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage("11")],
      availabilityContext: availability,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2026-10-27",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate).toBe("2026-10-27");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-27T11:00:00");
  });

  it("checkpoints the selected day before resolving its time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T09:00:00Z"));
    try {
    const multiDaySnapshot: AvailabilityContext = {
      days: [
        {
          date: "2026-10-08",
          dayLabel: "8 жовтня (четвер)",
          slots: [{
            id: "old",
            label: "13:30",
            dateStart: "2026-10-08T13:30:00",
            dateEnd: "2026-10-08T14:00:00",
          }],
        },
        {
          date: "2026-10-09",
          dayLabel: "9 жовтня (пʼятниця)",
          slots: [{
            id: "chosen",
            label: "13:30",
            dateStart: "2026-10-09T13:30:00",
            dateEnd: "2026-10-09T14:00:00",
          }],
        },
      ],
      stepMinutes: 30,
    };
    const dateUpdate = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage("9 жовтня (пʼятниця)")],
      availabilityContext: multiDaySnapshot,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: null,
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(dateUpdate.bookingDraft?.selectedDate).toBe("2026-10-09");
    expect(dateUpdate.bookingDraft?.selectedSlot).toBeNull();

    const timeUpdate = advanceBookingNoteStep(availabilityClinicState({
      messages: [
        new HumanMessage("9 жовтня (пʼятниця)"),
        new HumanMessage("13:30"),
      ],
      availabilityContext: multiDaySnapshot,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2026-10-09",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(timeUpdate.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-09T13:30:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("advanceBookingNoteStep enters awaiting on time pick even with prior procedure talk", async () => {
    const update = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("губи"), new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
        }),
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("awaiting");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot?.label).toBe("14:00");
  });

  it("checkpoints bare day, bare hour, and note skip as one canonical ladder", async () => {
    const availability: AvailabilityContext = {
      days: [
        {
          date: "2026-10-27",
          dayLabel: "27 жовтня (вівторок)",
          slots: [{
            id: "27-11",
            label: "11:00",
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
          }],
        },
        {
          date: "2026-10-28",
          dayLabel: "28 жовтня (середа)",
          slots: [{
            id: "28-11",
            label: "11:00",
            dateStart: "2026-10-28T11:00:00",
            dateEnd: "2026-10-28T11:30:00",
          }],
        },
      ],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const initial = canonicalBookingDraft({
      phase: "date",
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
    });
    const dated = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage("27")],
      availabilityContext: availability,
      bookingDraft: initial,
    })).bookingDraft!;
    expect(dated.selectedDate).toBe("2026-10-27");

    const timed = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage("11")],
      availabilityContext: availability,
      bookingDraft: dated,
    })).bookingDraft!;
    expect(timed.selectedSlot?.dateStart).toBe("2026-10-27T11:00:00");
    expect(timed.note.status).toBe("awaiting");

    const skipped = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage(INTENT_SKIP_LABEL)],
      availabilityContext: availability,
      bookingDraft: timed,
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
      },
    })).bookingDraft!;
    expect(skipped.note.status).toBe("skipped");
  });

  it("advanceBookingNoteStep skips on INTENT chip; free text stays for the note orch", async () => {
    const visitNote = {
      kind: "visit_note" as const,
      choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
    };
    expect(
      advanceBookingNoteStep(
        availabilityClinicState({
          messages: [new HumanMessage(INTENT_SKIP_LABEL)],
          bookingDraft: canonicalBookingDraft({
            phase: "note",
            note: { status: "awaiting" },
          }),
          pendingInteraction: visitNote,
          availabilityContext: snapshot,
        }),
      ).bookingDraft?.note.status,
    ).toBe("skipped");
    const freeText = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("хочу ботокс губ")],
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        pendingInteraction: visitNote,
        availabilityContext: snapshot,
      }),
    );
    expect(freeText.bookingDraft).toBeUndefined();
    expect(freeText.pendingInteraction).toBeUndefined();
  });

  it("treats a new explicit date as a date change while the note prompt is visible", async () => {
    const draft = {
      version: 3,
      mode: "create" as const,
      phase: "note" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" as const },
      },
      availability: null,
      selectedDate: "2026-11-20",
      selectedSlot: {
        dateStart: "2026-11-20T11:00:00",
        dateEnd: "2026-11-20T11:30:00",
        label: "11:00",
      },
      note: { status: "awaiting" as const },
      contactId: null,
      pendingCommand: null,
    };
    const update = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("на 21.11")],
        bookingDraft: draft,
        availabilityContext: snapshot,
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate).toBe("2026-11-21");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("awaiting");
  });

  it("selects the trusted interval without treating legacy step metadata as duration truth", async () => {
    const update = advanceBookingNoteStep(
      availabilityClinicState({
        messages: [new HumanMessage("12:30")],
        availabilityContext: {
          days: [{
            date: "2026-11-21",
            slots: [{
              id: "12:30",
              label: "12:30",
              dateStart: "2026-11-21T12:30:00",
              dateEnd: "2026-11-21T13:30:00",
            }],
          }],
          stepMinutes: 30,
          serviceId: "svc-neotiva",
        },
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "time",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
          selectedDate: "2026-11-21",
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: null,
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot?.dateEnd).toBe("2026-11-21T13:30:00");
    expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("awaiting");
  });

  it("DDD-48: code-owns skip-comment keyboard while note step is awaiting", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        stepCount: 1,
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        agentMessages: [
          new AIMessage("Чи можете поділитися деталями перед записом?"),
        ],
      }),
    );
    expect(update.lastHandoff?.replyButtons).toEqual([INTENT_SKIP_LABEL]);
    // Already awaiting: finalize does not rewrite the note aggregate.
    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
  });

  it("DDD-49/51: blocks unstamped create_meeting and opens note via command_prepare", async () => {
    const createTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      availabilityClinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    // Legacy unstamped runtime calls are stripped — no synthetic invariant ToolMessage.
    expect(agentMessagesOf(toolsUpdate).some((message) => message instanceof ToolMessage))
      .toBe(false);

    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      availabilityClinicState({
        stepCount: 2,
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        pendingInteraction: {
          kind: "visit_note",
          choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
        },
        agentMessages: [
          new AIMessage(BOOKING_NOTE_QUESTION_UK),
        ],
      }),
    );
    expect(update.lastHandoff?.replyText).toBe(BOOKING_NOTE_QUESTION_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([INTENT_SKIP_LABEL]);
  });

  it("strips unstamped create_meeting with consultation id (agreement is planner-owned)", async () => {
    const createTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("запиши на ботулінотерапію"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "c1",
              name: "create_meeting",
              args: {
                serviceId: CONSULTATION_SERVICE_ID,
                dateStart: "2026-09-10T14:00:00",
                dateEnd: "2026-09-10T14:30:00",
              },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(agentMessagesOf(toolsUpdate).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("allows create_meeting with consultation id after Так to consultation offer", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      availabilityClinicState({
        bookingNoteStatus: "skipped",
        contactContext: ownedContactContext(),
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "date",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: CONSULTATION_SERVICE_ID,
              name: "Консультація",
              source: "catalog",
            },
          },
          availability: null,
          selectedDate: null,
          selectedSlot: null,
          note: { status: "skipped" },
          contactId: "contact-1",
          pendingCommand: null,
        },
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("Так"),
        ],
        agentMessages: [
          runtimeToolAi([
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  serviceId: CONSULTATION_SERVICE_ID,
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(JSON.parse(String((toolsUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      awaitingConfirmation: true,
    });
  });

  it("captures the existing meeting when create_meeting reports Already booked", async () => {
    const createTool = tool(
      async () => JSON.stringify({
        error: "Already booked",
        meetings: [{
          id: "existing-1",
          name: "Консультація - Ada",
          dateStart: "2026-09-10 11:00:00",
          dateEnd: "2026-09-10 11:30:00",
        }],
      }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const update = await createAgentToolsNode([createTool], "booking")(
      availabilityClinicState({
        contactContext: ownedContactContext("c-1"),
        availabilityContext: snapshot,
        bookingDraft: {
          version: 3,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: {
            action: "create",
            payload: { serviceId: "svc-1" },
            idempotencyKey: "create:original",
            expiresAt: Date.now() + 60_000,
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              date: "2026-09-10",
              slots: [{
                label: "14:00",
                dateStart: "2026-09-10T14:00:00",
                dateEnd: "2026-09-10T14:30:00",
              }],
              stepMinutes: 30,
            }),
            name: "present_availability_slots",
            tool_call_id: "revalidate-1",
          }),
          runtimeToolAi([{ id: "create-1", name: "create_meeting", args: {}, type: "tool_call" }]),
        ],
      }),
      { configurable: {} },
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.replacement).toMatchObject({
      status: "offered",
      meeting: { id: "existing-1", name: "Консультація - Ada" },
      originalCommand: { idempotencyKey: "create:original" },
    });
  });

  it("records catalog consultation selection before accepting a generic procedure offer", async () => {
    const prepare = createBookingPrepareNode();
    const prepared = await prepare(availabilityClinicState({
      messages: [
        new HumanMessage("Консультація первинна"),
        new AIMessage("Бажаєте записатися на цю процедуру?"),
        new HumanMessage("Так"),
      ],
      bookingDraft: canonicalBookingDraft({
        phase: "service",
        serviceAcceptance: {
          status: "pending",
          service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        },
        selectedDate: null,
        selectedSlot: null,
        note: { status: "unasked" },
        contactId: null,
      }),
      lastHandoff: {
        agentId: "faq",
        agentName: "FAQ",
        status: "ok",
        replyText: "Бажаєте записатися на цю процедуру?",
      },
    }));

    expect(unwrapCommandUpdate(prepared).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
    });

    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      availabilityClinicState({
        ...prepared,
        contactContext: ownedContactContext(),
        bookingDraft: {
          ...unwrapCommandUpdate(prepared).bookingDraft!,
          phase: "details",
          note: { status: "skipped" },
          selectedDate: "2026-10-17",
          selectedSlot: {
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
            label: "11:30",
          },
          contactId: "contact-1",
        },
        agentMessages: [
          runtimeToolAi([{
              id: "catalog-consent",
              name: "create_meeting",
              args: { serviceId: CONSULTATION_SERVICE_ID },
              type: "tool_call",
            }]),
        ],
      }),
      { configurable: {} },
    );

    expect(JSON.parse(String((toolsUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      awaitingConfirmation: true,
    });
  });

  it("strips unstamped reschedule_meeting with consultation id (agreement is planner-owned)", async () => {
    const rescheduleTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "reschedule_meeting",
        description: "reschedule",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([rescheduleTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("запиши на ботулінотерапію"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "r1",
              name: "reschedule_meeting",
              args: {
                serviceId: CONSULTATION_SERVICE_ID,
                dateStart: "2026-09-10T14:00:00",
                dateEnd: "2026-09-10T14:30:00",
              },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(
      (toolsUpdate.agentMessages instanceof Overwrite
        ? toolsUpdate.agentMessages.value
        : toolsUpdate.agentMessages as unknown[]
      ).some((message) => message instanceof ToolMessage),
    ).toBe(false);
  });

  it("allows create_meeting after note step is skipped", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        agentMessages: [
          runtimeToolAi([
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).awaitingConfirmation).toBe(true);
  });

  it("keeps the frozen tool arguments when HITL returns a chat confirmation", async () => {
    const createTool = tool(
      async () => JSON.stringify({
        awaitingConfirmation: true,
        userReply: "Так",
        draft: {
          command: {
            action: "create",
            payload: { parentId: "c-1", status: "Planned" },
          },
        },
      }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const originalPayload = {
      name: "Процедура - Ada Lovelace",
      dateStart: "2026-09-10T14:00:00",
      dateEnd: "2026-09-10T14:30:00",
      contactId: "c-1",
      serviceId: "svc-1",
      confirmMessage: "Підтвердити запис?",
      description: "Короткий коментар.",
    };
    const update = await createAgentToolsNode([createTool], "booking")(
      availabilityClinicState({
        contactContext: ownedContactContext("c-1"),
        availabilityContext: snapshot,
        bookingDraft: canonicalBookingDraft({
          contactId: "c-1",
          phase: "confirming",
          pendingCommand: { action: "create", payload: originalPayload },
        }),
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify(snapshot),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          runtimeToolAi([{
              id: "create-1",
              name: "create_meeting",
              args: originalPayload,
              type: "tool_call",
            }]),
        ],
      }),
      { configurable: {} },
    );

    // command_prepare already checkpointed pendingCommand; tools must not rederive it.
    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
  });

  it("strips unstamped create after a failed slot revalidation ToolMessage", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        }),
        availabilityContext: snapshot,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ error: "CRM unavailable" }),
            name: "present_availability_slots",
            tool_call_id: "revalidate-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "create-1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it("strips unstamped create when selected interval mismatches snapshot (freshness is planner-owned)", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: {
          version: 2,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
          availability: null,
          selectedDate: "2026-11-21",
          selectedSlot: {
            slotId: "12:30",
            dateStart: "2026-11-21T12:30:00",
            dateEnd: "2026-11-21T13:00:00",
            label: "12:30",
          },
          note: { status: "skipped" },
          contactId: "contact-1",
          pendingCommand: {
            action: "create",
            payload: {
              dateStart: "2026-11-21T12:30:00",
              dateEnd: "2026-11-21T13:00:00",
            },
          },
        },
        availabilityContext: {
          serviceId: "svc-neotiva",
          stepMinutes: 60,
          days: [{
            date: "2026-11-21",
            slots: [{
              id: "12:30",
              label: "12:30",
              dateStart: "2026-11-21T12:30:00",
              dateEnd: "2026-11-21T13:30:00",
            }],
          }],
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "mismatch",
              name: "create_meeting",
              args: {
                dateStart: "2026-11-21T12:30:00",
                dateEnd: "2026-11-21T13:00:00",
              },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(
      (toolsUpdate.agentMessages instanceof Overwrite
        ? toolsUpdate.agentMessages.value
        : toolsUpdate.agentMessages as unknown[]
      ).some((message) => message instanceof ToolMessage),
    ).toBe(false);
  });

  it("DDD-50: HITL decline clears availability so next slots call is CRM", async () => {
    const createTool = tool(
      async () => JSON.stringify({ cancelled: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const declineUpdate = await toolsNode(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        availabilityContext: snapshot,
        agentMessages: [
          runtimeToolAi([{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }]),
        ],
      }),
      { configurable: {} },
    );
    expect(JSON.parse(String((declineUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      cancelled: true,
    });
    expect(declineUpdate.availabilityContext).toBeNull();
  });

  it("REPLACE cancel commit nulls availability but keeps selectedSlot and note", async () => {
    const cancelTool = tool(
      async () => JSON.stringify({ success: true, id: "m-1" }),
      {
        name: "cancel_meeting",
        description: "cancel",
        schema: z.object({ meetingId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([cancelTool], "booking");
    const update = await toolsNode(
      availabilityClinicState({
        bookingNoteStatus: "skipped",
        availabilityContext: snapshot,
        selectedSlot: {
          dateStart: "2026-09-29T12:00:00",
          dateEnd: "2026-09-29T13:00:00",
          label: "12:00",
        },
        agentMessages: [
          runtimeToolAi([
              {
                id: "c1",
                name: "cancel_meeting",
                args: { meetingId: "m-1" },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
  });

  it("committed create_meeting still resets selectedSlot and note", async () => {
    const createTool = tool(
      async () => JSON.stringify({ success: true, id: "m-new" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const update = await toolsNode(
      availabilityClinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
        }),
        availabilityContext: snapshot,
        agentMessages: [
          runtimeToolAi([{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }]),
        ],
      }),
      { configurable: {} },
    );
    expect(update.availabilityContext).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
  });

  it.each([
    { label: OTHER_DATE_LABEL, llmAfter: "2025-10-05" },
    { label: OTHER_DATE_LABEL_EN, llmAfter: "2025-10-05" },
    { label: "Інша", llmAfter: undefined },
  ])(
    "rewrites afterDate from checkpoint on other-date ($label)",
    async ({ label, llmAfter }) => {
      const multiDay: AvailabilityContext = {
        days: [
          snapshot.days[0]!,
          {
            date: "2026-10-05",
            dayLabel: "5 жовтня (понеділок)",
            slots: [
              {
                id: "c",
                label: "11:00",
                dateStart: "2026-10-05T11:00:00",
                dateEnd: "2026-10-05T11:30:00",
              },
            ],
          },
        ],
        stepMinutes: 30,
      };
      const invoked: Array<Record<string, unknown>> = [];
      const slotsTool = tool(
        async (input: Record<string, unknown>) => {
          invoked.push(input);
          return JSON.stringify({
            days: [
              {
                date: "2026-10-06",
                dayLabel: "6 жовтня (вівторок)",
                slots: [
                  {
                    id: "d",
                    label: "11:00",
                    dateStart: "2026-10-06T11:00:00",
                    dateEnd: "2026-10-06T11:30:00",
                  },
                ],
              },
            ],
            stepMinutes: 30,
          });
        },
        {
          name: "present_availability_slots",
          description: "slots",
          schema: z.object({
            durationMinutes: z.number().optional(),
            date: z.string().optional(),
            afterDate: z.string().optional(),
          }),
        },
      );
      // Runtime owns paging: command_prepare builds later args from the cursor/snapshot.
      const prepared = await createAgentCommandPrepareNode()(
        availabilityClinicState({
          messages: [new HumanMessage(label)],
          availabilityContext: multiDay,
          availabilityCursor: {
            firstDate: "2026-10-03",
            lastDate: "2026-10-05",
            query: {
              kind: "nearest",
              rangeFrom: "2026-10-03",
              rangeThrough: "2026-10-05",
              coverageComplete: true,
            },
          },
          agentMessages: [new HumanMessage(label)],
        }),
      );
      const call = lastToolCallFromPrepare(prepared);
      expect(call).toMatchObject({
        name: "present_availability_slots",
        args: expect.objectContaining({
          direction: "later",
          afterDate: "2026-10-05",
          durationMinutes: 30,
        }),
      });
      const toolsNode = createAgentToolsNode([slotsTool], "booking");
      const update = await toolsNode(
        availabilityClinicState({
          messages: [new HumanMessage(label)],
          availabilityContext: multiDay,
          agentMessages: [
            ...(unwrapCommandUpdate(prepared).agentMessages instanceof Overwrite
              ? (unwrapCommandUpdate(prepared).agentMessages as Overwrite<AIMessage[]>).value
              : []),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toHaveLength(1);
      expect(invoked[0]).toMatchObject({ durationMinutes: 30, afterDate: "2026-10-05" });
      expect(update.availabilityContext?.days[0]?.date).toBe("2026-10-06");
    },
  );

  it("ignores leaked Gemini XML for tools not bound to the agent", async () => {
    const { createAgentLlmNode } = await import("../agent-loop/index.js");
    const leaked =
      "<call:default_api:create_meeting{serviceId: demo}></call:default_api:create_meeting>";
    const invoke = vi.fn(async () => new AIMessage(leaked));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({}),
      },
    );
    const llm = createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      availabilityClinicState({
        messages: [new HumanMessage("ok")],
        agentMessages: [new HumanMessage("ok")],
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(String(ai.content)).not.toContain("call:default_api");
    expect(ai.tool_calls ?? []).toEqual([]);
  });

  it("strips native tool_calls for tools not bound to the agent", async () => {
    const { createAgentLlmNode } = await import("../agent-loop/index.js");
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers questions",
      systemPrompt: "faq",
      maxSteps: 8,
    };
    const readTool = tool(async () => "ok", {
      name: "list_services",
      description: "services",
      schema: z.object({}),
    });
    const invoke = vi.fn(async () =>
      new AIMessage({
        content: "Ось каталог послуг.",
        tool_calls: [
          {
            id: "stale_faq_catalog",
            name: "faq_catalog_action",
            args: { action: "keep_catalog" },
            type: "tool_call",
          },
        ],
      }),
    );
    const llm = createAgentLlmNode({
      agent: faqAgent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [readTool],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      availabilityClinicState({
        messages: [new HumanMessage("Послуги")],
        agentMessages: [new HumanMessage("Послуги")],
        next: "faq",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls ?? []).toEqual([]);
    expect(String(ai.content)).toBe("Ось каталог послуг.");
  });

  it("command_prepare injects present_availability_slots when DATE has no snapshot", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Так")],
        agentMessages: [new HumanMessage("Так")],
        availabilityContext: null,
        next: "booking",
      }),
    );
    const ai = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1)!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: expect.objectContaining({ direction: "nearest", forceRefresh: true }),
      }),
    ]);
  });

  it("command_prepare forces availability lookup for direct reschedule instead of a day prompt", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Перенести")],
        agentMessages: [new HumanMessage("Перенести")],
        bookingContext: makeListedMeetings(),
        bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
          type: "reschedule_started",
          meeting: makeListedMeetings().meetings[0]!,
        }),
        availabilityContext: null,
        next: "booking",
      }),
    );
    const ai = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1)!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: {
          direction: "nearest",
          durationMinutes: 30,
          excludeMeetingIds: ["m-1"],
          forceRefresh: true,
        },
      }),
    ]);
  });

  it("command_prepare starts a fresh nearest search after service accept clears stale snapshot", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      availabilityClinicState({
        messages: [new HumanMessage("Так")],
        agentMessages: [new HumanMessage("Так")],
        // Accept path clears availability; runtime then owns nearest.
        availabilityContext: null,
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Підібрати вільний час на консультацію?",
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        next: "booking",
      }),
    );
    const ai = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1)!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: expect.objectContaining({ direction: "nearest", forceRefresh: true }),
      }),
    ]);
  });

  it.each([OTHER_DATE_LABEL, "другая дата", "другая", "другой"])(
    "LLM no longer synthesizes present_availability_slots for alternative-date reply %s",
    async (otherDateReply) => {
    const llm = bookingLlmReturning("Добре");
    const llmUpdate = await llm(
      availabilityClinicState({
        messages: [new HumanMessage(otherDateReply)],
        agentMessages: [new HumanMessage(otherDateReply)],
        availabilityContext: snapshot,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    // Coercion no longer injects availability; informational bind has no slots tool.
    expect(ai.tool_calls ?? []).toEqual([]);
    },
  );

  it("command_prepare injects the validated exact date when schedule is pending", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T09:00:00Z"));
      const commandPrepare = createAgentCommandPrepareNode();
      const draft = reduceBookingDraft(
        acceptedCreateDraft({ phase: "date", note: { status: "unasked" } }),
        { type: "schedule_requested", date: "2026-10-20" },
      );
      const update = await commandPrepare(
        availabilityClinicState({
          messages: [new HumanMessage("20 жовтня")],
          agentMessages: [new HumanMessage("20 жовтня")],
          bookingDraft: draft,
          availabilityContext: snapshot,
          next: "booking",
        }),
      );
      const ai = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1)!;
      expect(ai.tool_calls).toEqual([
        expect.objectContaining({
          name: "present_availability_slots",
          args: expect.objectContaining({
            direction: "exact",
            date: "2026-10-20",
            forceRefresh: true,
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("command_prepare anchors a bare day via schedule_requested before inventing slots", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-28T09:00:00Z"));
      const commandPrepare = createAgentCommandPrepareNode();
      const draft = reduceBookingDraft(
        canonicalBookingDraft({
          phase: "time",
          selectedDate: "2026-10-25",
          selectedSlot: null,
          note: { status: "unasked" },
        }),
        { type: "schedule_requested", date: "2026-10-26", preferredTime: undefined },
      );
      const update = await commandPrepare(
        availabilityClinicState({
          messages: [new HumanMessage("26")],
          agentMessages: [new HumanMessage("26")],
          availabilityContext: {
            days: [{ date: "2026-10-25", slots: [] }],
            stepMinutes: 30,
            query: {
              kind: "exact",
              date: "2026-10-25",
              rangeFrom: "2026-10-25",
              rangeThrough: "2026-10-25",
              coverageComplete: true,
            },
          },
          bookingDraft: draft,
          next: "booking",
        }),
      );
      const ai = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value.at(-1)!;
      expect(ai.tool_calls).toEqual([
        expect.objectContaining({
          name: "present_availability_slots",
          args: expect.objectContaining({
            direction: "exact",
            date: "2026-10-26",
            forceRefresh: true,
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-inject slots after «Інша дата» already paged this turn", async () => {
    const llm = bookingLlmReturning(formatAvailabilityDateOffer(snapshot.days).replyText);
    const llmUpdate = await llm(
      availabilityClinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        agentMessages: [
          new HumanMessage(OTHER_DATE_LABEL),
          runtimeToolAi([
              {
                id: "s1",
                name: "present_availability_slots",
                args: { afterDate: "2026-09-10", durationMinutes: 30 },
                type: "tool_call",
              },
            ]),
          new ToolMessage({
            content: JSON.stringify({
              days: snapshot.days,
              stepMinutes: 30,
            }),
            tool_call_id: "s1",
            name: "present_availability_slots",
          }),
        ],
        availabilityContext: snapshot,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls ?? []).toEqual([]);
  });

  it("DATE keyboard attaches on cache-hit tool turn; date prose without tool gets no DATE chips", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const withTool = await finalize(
      availabilityClinicState({
        stepCount: 2,
        availabilityContext: {
          days: [
            snapshot.days[0]!,
            {
              date: "2026-09-11",
              dayLabel: "11 вересня (п'ятниця)",
              slots: [
                {
                  id: "c",
                  label: "12:00",
                  dateStart: "2026-09-11T12:00:00",
                  dateEnd: "2026-09-11T12:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          runtimeToolAi([{ id: "s1", name: "present_availability_slots", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({
              days: [
                snapshot.days[0],
                {
                  date: "2026-09-11",
                  dayLabel: "11 вересня (п'ятниця)",
                  slots: [
                    {
                      label: "12:00",
                      dateStart: "2026-09-11T12:00:00",
                      dateEnd: "2026-09-11T12:30:00",
                    },
                  ],
                },
              ],
              stepMinutes: 30,
              cacheHit: true,
            }),
            tool_call_id: "s1",
            name: "present_availability_slots",
          }),
          new AIMessage("invented hours 09:00"),
        ],
      }),
    );
    expect(withTool.lastHandoff?.replyButtons).toEqual([
      "10 вересня",
      "11 вересня",
      OTHER_DATE_LABEL,
    ]);

    const proseOnly = await finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: {
          days: [
            snapshot.days[0]!,
            {
              date: "2026-09-11",
              dayLabel: "11 вересня (п'ятниця)",
              slots: [
                {
                  id: "c",
                  label: "12:00",
                  dateStart: "2026-09-11T12:00:00",
                  dateEnd: "2026-09-11T12:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          new HumanMessage("коли зручно?"),
          new AIMessage("Є вільні дні 10 і 11 вересня."),
        ],
      }),
    );
    expect(proseOnly.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("does not attach navigation when an empty-date model reply has no validated tool result", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        availabilityContext: {
          days: [
            {
              date: "2099-10-19",
              dayLabel: "19 жовтня (понеділок)",
              slots: [],
            },
          ],
          stepMinutes: 30,
          searchDirection: "later",
          searchedFrom: "2099-10-19",
        },
        agentMessages: [
          new HumanMessage("18 жовтня"),
          new AIMessage("На цю дату вільного часу немає. Пошукати іншу дату?"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("injects one compact booking draft and not full availability into booking LLM context", async () => {
    const bindTools = vi.fn(() => ({
      invoke: vi.fn(async (messages: unknown[]) => {
        const dynamic = messages[0] as HumanMessage;
        expect(String(dynamic.content)).not.toContain("<availability>");
        expect(String(dynamic.content)).toContain("<booking_draft>");
        expect(String(dynamic.content)).toContain("2026-09-10T14:00:00");
        return new AIMessage("ok");
      }),
    }));
    const model = { bindTools } as unknown as BaseChatModel;
    const llm = createAgentLlmNode({
      agent,
      model,
      tools: [],
      formatSystemMetadata: () => "DYN",
    });
    await llm(
      availabilityClinicState({
        agentMessages: [new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "note",
          serviceAcceptance: null,
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "awaiting" },
          contactId: null,
          pendingCommand: null,
        },
      }),
    );
  });

  it("prepare defers TIME clock picks to note orch; advanceBookingNoteStep still resolves the slot", async () => {
    const draft = canonicalBookingDraft({
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      note: { status: "unasked" },
    });
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      availabilityClinicState({
        messages: [new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: draft,
      }),
    );
    expect(update.noteOrchQueued).toBe(true);
    expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("unasked");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot).toBeNull();

    const advanced = advanceBookingNoteStep(availabilityClinicState({
      messages: [new HumanMessage("14:00")],
      availabilityContext: snapshot,
      bookingDraft: draft,
    }));
    expect(advanced.bookingDraft?.note.status).toBe("awaiting");
    expect(advanced.bookingDraft?.selectedSlot?.label).toBe("14:00");
  });
});



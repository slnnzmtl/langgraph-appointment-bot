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
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
} from "../booking-draft.js";

import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  lastToolCallFromPrepare,
  ownedContactContext,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";
import {
  acceptedCreateDraft,
  availabilityClinicState,
  bookingIntegrationAgent as agent,
  bookingIntegrationSnapshot as snapshot,
} from "./agent-loop-booking-integration-harness.js";


/**
 * Legacy integration scenarios. Obsolete skipped cases removed in DDD-267
 * (planner-owned mutations, tools-protocol stamp gate, availability cache paging).
 * Pure matchAvailabilitySlot/Day cases live in agent-loop-availability.test.ts.
 */
describe("booking schedule and note step integration", () => {
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

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
describe("booking HITL and command_prepare integration", () => {
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

});



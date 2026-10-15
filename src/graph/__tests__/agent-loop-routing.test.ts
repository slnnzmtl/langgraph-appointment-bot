import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, Overwrite } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CONSULTATION_SERVICE_ID,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import {
  createAgentCommandPrepareNode,
  createAgentToolsNode,
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { resolveBookingCommand, stampRuntimeToolAi } from "../agent-loop/booking-command.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../booking-draft.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";

const agentMessagesOf = (update: { agentMessages?: unknown }): BaseMessage[] => {
  const raw = update.agentMessages;
  if (raw instanceof Overwrite) {
    return raw.value as BaseMessage[];
  }
  return Array.isArray(raw) ? (raw as BaseMessage[]) : [];
};

const unwrapCommandUpdate = (result: unknown): ClinicStateUpdate =>
  result instanceof Command ? (result.update as ClinicStateUpdate) : (result as ClinicStateUpdate);


const listedMeetings: BookingContext = {
  meetings: [
    {
      id: "m-1",
      name: "Консультація - Daniel",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    },
  ],
  dateFrom: "2026-08-11",
};

const ownedContactContext = (contactId = "contact-1"): ContactLookupContext => ({
  ownership: "telegram",
  contacts: [{
    id: contactId,
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    missingFields: [],
  }],
});

const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  supervisorIntent: null,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  availabilityCursor: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
  selectedAvailabilityDate: null,
  bookingDraft: null,
  pendingInteraction: null,
  noteOrchQueued: false,
  serviceChangeNotice: null,
  bookingSchemaVersion: 1,
  pendingCancellationPurpose: null,
  ...overrides,
});

const canonicalBookingDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft => ({
  version: 1,
  mode: "create",
  phase: "details",
  serviceAcceptance: {
    status: "accepted",
    service: {
      id: "svc-1",
      name: "Процедура",
      source: "catalog",
    },
  },
  selectedDate: "2026-09-10",
  selectedSlot: {
    dateStart: "2026-09-10T14:00:00",
    dateEnd: "2026-09-10T14:30:00",
    label: "14:00",
  },
  requestedTime: null,
  note: { status: "skipped" },
  contactId: "contact-1",
  pendingCommand: null,
  replacement: null,
  ...overrides,
});

describe("routeAfterAgentLlm", () => {
  it("routes a direct cancellation to runtime command preparation even after plain model text", async () => {
    expect(
      routeAfterAgentLlm(
        clinicState({
          messages: [new HumanMessage("Скасувати")],
          bookingContext: listedMeetings,
          bookingDraft: {
            ...createEmptyBookingDraft(),
            pendingCommand: {
              action: "cancel",
              payload: { meetingId: "m-1", confirmMessage: "Скасувати цей візит?" },
            },
          },
          agentMessages: [new AIMessage("Запис скасовано")],
          stepCount: 1,
        }),
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("routes a ready draft to runtime command preparation before the step limit", async () => {
    expect(
      routeAfterAgentLlm(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft(),
          agentMessages: [new AIMessage("Готово! Запис створено.")],
          stepCount: 5,
        }),
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });
});

describe("runtime-owned booking routing", () => {
  it("bypasses the LLM when prepare has a complete booking draft", async () => {
    expect(
      routeAfterAgentPrepare(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft(),
        }),
        "booking__llm",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("uses the LLM while canonical booking facts are still missing", async () => {
    expect(
      routeAfterAgentPrepare(
        clinicState({
          bookingDraft: canonicalBookingDraft({
            phase: "note",
            note: { status: "awaiting" },
          }),
        }),
        "booking__llm",
        "booking__command_prepare",
      ),
    ).toBe("booking__llm");
  });

  it("routes a checkpointed bare-day selection to availability before the LLM", async () => {
    const state = clinicState({
      messages: [new HumanMessage("26")],
      agentMessages: [new HumanMessage("26")],
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2099-10-26",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
      availabilityContext: {
        days: [{ date: "2099-10-25", slots: [] }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2099-10-25",
          rangeFrom: "2099-10-25",
          rangeThrough: "2099-10-25",
          coverageComplete: true,
        },
      },
    });
    expect(
      routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"),
    ).toBe("booking__command_prepare");

    const update = await createAgentCommandPrepareNode("booking")(state);
    const prepared = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const call = prepared.at(-1)?.tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: { direction: "exact", date: "2099-10-26" },
    });
  });

  it("requests nearest availability for a service-change notice with the new duration", async () => {
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const state = clinicState({
      messages: [new HumanMessage("Neotiva")],
      agentMessages: [new HumanMessage("Neotiva")],
      serviceChangeNotice: notice,
      bookingDraft: canonicalBookingDraft({
        phase: "date",
        selectedDate: null,
        selectedSlot: null,
        note: { status: "answered", value: "запиши на збільшення губ" },
        serviceAcceptance: {
          status: "accepted",
          service: {
            id: "svc-neotiva",
            name: "Збільшення губ Neotiva",
            durationMinutes: 60,
            source: "catalog",
          },
        },
      }),
      availabilityContext: null,
    });
    expect(
      routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"),
    ).toBe("booking__command_prepare");

    const update = await createAgentCommandPrepareNode("booking")(state);
    const prepared = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const call = prepared.at(-1)?.tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "nearest",
        forceRefresh: true,
        durationMinutes: 60,
      },
    });
  });

  it("continues successful slot revalidation directly to command preparation", async () => {
    expect(
      routeAfterAgentTools(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft({
            phase: "confirming",
            serviceAcceptance: {
              status: "accepted",
              service: {
                id: "svc-1",
                name: "Процедура",
                durationMinutes: 30,
                source: "catalog",
              },
            },
            pendingCommand: {
              action: "create",
              payload: { serviceId: "svc-1" },
            },
          }),
          agentMessages: [
            new ToolMessage({
              content: JSON.stringify({
                date: "2026-09-10",
                slots: [{
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
                // Snapshot metadata is not authoritative; the exact interval is.
                stepMinutes: 45,
              }),
              name: "present_availability_slots",
              tool_call_id: "revalidate-1",
            }),
          ],
        }),
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("does not continue command preparation when fresh revalidation fails", async () => {
    expect(
      routeAfterAgentTools(
        clinicState({
          bookingDraft: canonicalBookingDraft({
            phase: "confirming",
            pendingCommand: {
              action: "create",
              payload: { serviceId: "svc-1" },
            },
          }),
          agentMessages: [
            new ToolMessage({
              content: JSON.stringify({ error: "CRM unavailable" }),
              name: "present_availability_slots",
              tool_call_id: "revalidate-1",
            }),
          ],
        }),
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__llm");
  });

  it("renders consultation service_confirm without a tool when agreement is missing", async () => {
    const state = clinicState({
      bookingDraft: canonicalBookingDraft({
        serviceAcceptance: {
          status: "pending",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
        },
        pendingCommand: {
          action: "create",
          payload: { serviceId: CONSULTATION_SERVICE_ID },
        },
      }),
      pendingInteraction: null,
    });
    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({
      kind: "render",
      reason: "consultation_agreement",
    });
    if (outcome.kind !== "render") {
      return;
    }
    expect(outcome.update.pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    expect(outcome.update.agentMessages).toBeUndefined();
  });

  it("strips ownership-blocked create without a synthetic ToolMessage and opens contact_field", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({ contactId: z.string().optional() }),
    });
    const state = clinicState({
      contactContext: null,
      bookingDraft: canonicalBookingDraft({
        contactId: null,
        note: { status: "skipped" },
      }),
      agentMessages: [
        stampRuntimeToolAi("create_meeting", [{
          id: "create-1",
          name: "create_meeting",
          args: { contactId: "unverified" },
          type: "tool_call" as const,
        }]),
      ],
    });
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      state,
      { configurable: {} },
    );
    expect(invoke).not.toHaveBeenCalled();
    const afterTools = {
      ...state,
      ...toolsUpdate,
      agentMessages: agentMessagesOf(toolsUpdate),
      pendingInteraction: toolsUpdate.pendingInteraction ?? state.pendingInteraction,
    };
    expect(afterTools.agentMessages.some((m) => m instanceof ToolMessage)).toBe(false);
    expect(afterTools.pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "phoneNumber",
    });
    expect(routeAfterAgentTools(
      afterTools,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
      undefined,
      "booking__finalize",
    )).toBe("booking__finalize");
  });

  it("routes incomplete-contact booking errors to command_prepare, not the LLM", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-1",
          firstName: "Ada",
          lastName: null,
          phoneNumber: "+380501112233",
          missingFields: ["lastName"],
        }],
      },
      bookingDraft: canonicalBookingDraft({
        contactId: "c-1",
        note: { status: "skipped" },
      }),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "Contact incomplete", missingFields: ["lastName"] }),
        name: "create_meeting",
        tool_call_id: "create-incomplete-1",
      })],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const prepared = await createAgentCommandPrepareNode("booking")(state);
    const update = unwrapCommandUpdate(prepared);
    expect(update.pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(update.agentMessages).toBeUndefined();
  });

  it("routes Not authorized to mutation_finalize, not the LLM", async () => {
    const state = clinicState({
      contactContext: null,
      bookingContext: null,
      bookingDraft: canonicalBookingDraft({
        mode: "reschedule",
        phase: "confirming",
        contactId: null,
        selectedDate: "2026-09-10",
        selectedSlot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
        },
        pendingCommand: {
          action: "reschedule",
          payload: { meetingId: "m-1" },
        },
        rescheduleTarget: { id: "m-1" },
      }),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "Not authorized" }),
        name: "reschedule_meeting",
        tool_call_id: "reschedule-auth-1",
      })],
    });
    const invalidated = reduceBookingDraft(state.bookingDraft, { type: "contact_unresolved" });
    const afterFailure = { ...state, bookingDraft: invalidated };

    expect(invalidated).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: null,
      selectedDate: null,
      selectedSlot: null,
      pendingCommand: null,
    });
    expect(routeAfterAgentTools(
      afterFailure,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__mutation_finalize");
    expect(routeAfterAgentPrepare(afterFailure, "booking__llm", "booking__command_prepare"))
      .toBe("booking__llm");
  });

  it("keeps HITL create chat-other informational without replaying the frozen mutation", async () => {
    const state = clinicState({
      messages: [new HumanMessage("скільки коштує консультація")],
      bookingContext: listedMeetings,
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        pendingCommand: null,
      }),
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
    });
    // Model may answer the FAQ during chat-other; command_prepare must not
    // re-inject create_meeting with the frozen payload.
    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__finalize");
    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("none");
    expect(outcome).not.toMatchObject({ kind: "execute" });
  });
});

import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
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
  BOOKING_NOTE_QUESTION_UK,
  CONSULTATION_SERVICE_ID,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import {
  createAgentCommandPrepareNode,
  createAgentToolsNode,
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { resolveBookingCommand } from "../agent-loop/booking-command.js";
import { stampRuntimeToolAi } from "../agent-loop/runtime-tool-stamp.js";
import {
  latestContactIncompleteMissingFields,
  latestMeetingMutationError,
} from "../agent-loop/protocol.js";
import { createBookingInteractionRenderNode } from "../booking-note-orchestrator.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import { openMutationConfirmInteraction } from "../booking-session.js";
import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  makeListedMeetings,
  ownedContactContext,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";

describe("routeAfterAgentLlm", () => {
  it("routes a direct cancellation to runtime command preparation even after plain model text", async () => {
    expect(
      routeAfterAgentLlm(
        clinicState({
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

  it("routes failed revalidation through command_prepare for contact or stale recovery", async () => {
    const state = clinicState({
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
    });
    // Without owned contact the planner opens contact_field (not the LLM).
    // The old boolean gate returned false here because createCommand was null.
    expect(resolveBookingCommand(state)).toMatchObject({
      kind: "render",
      reason: "contact_field",
    });
    expect(
      routeAfterAgentTools(
        state,
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
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
      bookingContext: makeListedMeetings(),
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
    expect(outcome.kind).toBe("continue_llm");
    expect(outcome).not.toMatchObject({ kind: "execute" });
  });

  it("stale-slot create recovery opens TIME select and keeps availability", async () => {
    const remaining = {
      label: "15:00",
      dateStart: "2026-09-10T15:00:00",
      dateEnd: "2026-09-10T15:30:00",
    };
    const snapshot = {
      days: [{ date: "2026-09-10", slots: [{ ...remaining, id: remaining.dateStart }] }],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const state = clinicState({
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
      availabilityContext: snapshot,
      pendingInteraction: openMutationConfirmInteraction("create"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({
          date: "2026-09-10",
          slots: [remaining],
          stepMinutes: 30,
          serviceId: "svc-1",
        }),
        name: "present_availability_slots",
        tool_call_id: "revalidate-stale-create",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({ kind: "render", reason: "stale_slot" });
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.pendingInteraction).toMatchObject({ kind: "time_select" });
    expect(outcome.update.bookingDraft).toMatchObject({
      selectedSlot: null,
      pendingCommand: null,
      selectedDate: "2026-09-10",
    });
    // This-turn capture wins and is written back onto the checkpoint.
    expect(outcome.update.availabilityContext).toMatchObject({
      days: [{ date: "2026-09-10", slots: [expect.objectContaining({ dateStart: remaining.dateStart })] }],
    });

    const rendered = createBookingInteractionRenderNode({ id: "booking", name: "Booking" })({
      ...state,
      ...outcome.update,
    } as ClinicState);
    expect((rendered.lastHandoff as { replyText: string }).replyText)
      .not.toBe(BOOKING_NOTE_QUESTION_UK);
    expect((rendered.lastHandoff as { replyButtons: string[] }).replyButtons)
      .toContain("15:00");
  });

  it("stale-slot reschedule recovery opens TIME select, not visit_note", async () => {
    const remaining = {
      label: "16:00",
      dateStart: "2026-09-10T16:00:00",
      dateEnd: "2026-09-10T16:30:00",
    };
    const snapshot = {
      days: [{ date: "2026-09-10", slots: [{ ...remaining, id: remaining.dateStart }] }],
      stepMinutes: 30,
      excludeMeetingIds: ["m-1"],
    };
    const state = clinicState({
      contactContext: ownedContactContext(),
      bookingDraft: canonicalBookingDraft({
        mode: "reschedule",
        phase: "confirming",
        note: { status: "skipped" },
        rescheduleTarget: {
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        },
        pendingCommand: {
          action: "reschedule",
          payload: { meetingId: "m-1" },
        },
      }),
      availabilityContext: snapshot,
      pendingInteraction: openMutationConfirmInteraction("reschedule"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({
          date: "2026-09-10",
          slots: [remaining],
          stepMinutes: 30,
          excludeMeetingIds: ["m-1"],
        }),
        name: "present_availability_slots",
        tool_call_id: "revalidate-stale-reschedule",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({ kind: "render", reason: "stale_slot" });
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.pendingInteraction).toMatchObject({ kind: "time_select" });
    expect(outcome.update.bookingDraft).toMatchObject({
      selectedSlot: null,
      pendingCommand: null,
    });

    const rendered = createBookingInteractionRenderNode({ id: "booking", name: "Booking" })({
      ...state,
      ...outcome.update,
    } as ClinicState);
    expect((rendered.lastHandoff as { replyText: string }).replyText)
      .not.toBe(BOOKING_NOTE_QUESTION_UK);
  });

  it("stale-slot revalidation error does not reoffer a checkpointed time", async () => {
    const staleSlot = {
      id: "2026-09-10T10:00:00",
      label: "10:00",
      dateStart: "2026-09-10T10:00:00",
      dateEnd: "2026-09-10T10:30:00",
    };
    const state = clinicState({
      contactContext: ownedContactContext(),
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        selectedSlot: {
          dateStart: staleSlot.dateStart,
          dateEnd: staleSlot.dateEnd,
          label: staleSlot.label,
        },
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
      availabilityContext: {
        days: [{ date: "2026-09-10", slots: [staleSlot] }],
        stepMinutes: 30,
        serviceId: "svc-1",
      },
      pendingInteraction: openMutationConfirmInteraction("create"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "CRM down", slots: [] }),
        name: "present_availability_slots",
        tool_call_id: "revalidate-crm-down",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("execute");
    if (outcome.kind !== "execute") {
      throw new Error("expected execute");
    }
    expect(outcome.toolCall).toMatchObject({
      name: "present_availability_slots",
      args: expect.objectContaining({
        direction: "exact",
        date: "2026-09-10",
        forceRefresh: true,
      }),
    });
    expect(outcome.update.pendingInteraction?.kind).not.toBe("time_select");
    expect(outcome.update.availabilityContext).toBeNull();
    expect(outcome.update.bookingDraft).toMatchObject({
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("stale-slot without usable snapshot force-refreshes exact availability", async () => {
    const state = clinicState({
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
      availabilityContext: null,
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "CRM down", slots: [] }),
        name: "present_availability_slots",
        tool_call_id: "revalidate-bad",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("execute");
    if (outcome.kind !== "execute") {
      throw new Error("expected execute");
    }
    expect(outcome.toolCall).toMatchObject({
      name: "present_availability_slots",
      args: expect.objectContaining({
        direction: "exact",
        date: "2026-09-10",
        forceRefresh: true,
      }),
    });
    expect(outcome.toolCall.id).toMatch(/^booking_stale_revalidate_/);
    expect(outcome.update.pendingInteraction?.kind).not.toBe("visit_note");
  });

  it("stale-slot does not execute a second force-refresh after booking_stale_revalidate", async () => {
    const state = clinicState({
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
      availabilityContext: null,
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "CRM down", slots: [] }),
        name: "present_availability_slots",
        tool_call_id: "booking_stale_revalidate_1",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({ kind: "render", reason: "missing_exact_date" });
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.bookingDraft).toMatchObject({
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("Contact incomplete with stale-complete cache opens contact_field and clears confirm", async () => {
    const state = clinicState({
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
      bookingDraft: canonicalBookingDraft({
        contactId: "c-1",
        note: { status: "skipped" },
        pendingCommand: {
          action: "create",
          payload: { contactId: "c-1" },
        },
      }),
      pendingInteraction: openMutationConfirmInteraction("create"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["lastName"],
        }),
        name: "create_meeting",
        tool_call_id: "create-incomplete-stale-cache",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({ kind: "render", reason: "contact_field" });
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(outcome.update.bookingDraft).toMatchObject({ pendingCommand: null });
    expect(outcome.update.contactContext).toMatchObject({
      contacts: [{
        id: "c-1",
        lastName: null,
        missingFields: ["lastName"],
      }],
    });
    expect(outcome.kind).not.toBe("none");
  });

  it("Contact incomplete on reschedule clears confirm without opening contact_field", async () => {
    const state = clinicState({
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
      bookingDraft: canonicalBookingDraft({
        mode: "reschedule",
        phase: "confirming",
        contactId: "c-1",
        note: { status: "skipped" },
        rescheduleTarget: {
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        },
        pendingCommand: {
          action: "reschedule",
          payload: { meetingId: "m-1" },
        },
      }),
      pendingInteraction: openMutationConfirmInteraction("reschedule"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["lastName"],
        }),
        name: "reschedule_meeting",
        tool_call_id: "reschedule-incomplete-1",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("render");
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.pendingInteraction?.kind).not.toBe("contact_field");
    expect(outcome.update.pendingInteraction?.kind).not.toBe("mutation_confirm");
    expect(outcome.update.bookingDraft).toMatchObject({ pendingCommand: null });
  });

  it("Contact incomplete opens contact_field even when draft already has the CRM field", async () => {
    const state = clinicState({
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
      bookingDraft: canonicalBookingDraft({
        contactId: "c-1",
        note: { status: "skipped" },
        contactDetails: { lastName: "Lovelace" },
        pendingCommand: {
          action: "create",
          payload: { contactId: "c-1" },
        },
      }),
      pendingInteraction: openMutationConfirmInteraction("create"),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["lastName"],
        }),
        name: "create_meeting",
        tool_call_id: "create-incomplete-draft-has-field",
      })],
    });

    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({ kind: "render", reason: "contact_field" });
    if (outcome.kind !== "render") {
      throw new Error("expected render");
    }
    expect(outcome.update.pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(outcome.kind).not.toBe("execute");
  });
});

describe("latestContactIncompleteMissingFields", () => {
  it("returns CRM missingFields when the latest meeting mutation is Contact incomplete", () => {
    expect(latestContactIncompleteMissingFields([
      new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["lastName", "bogus"],
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
    ])).toEqual(["lastName"]);
  });

  it("is null when the latest meeting mutation is not Contact incomplete", () => {
    expect(latestContactIncompleteMissingFields([
      new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["lastName"],
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
      new ToolMessage({
        content: JSON.stringify({ error: "Not authorized" }),
        name: "reschedule_meeting",
        tool_call_id: "reschedule-1",
      }),
    ])).toBeNull();
  });

  it("ignores link_telegram_to_contact even when it says Contact incomplete", () => {
    const messages = [
      new ToolMessage({
        content: JSON.stringify({
          error: "Contact incomplete",
          missingFields: ["phoneNumber"],
        }),
        name: "link_telegram_to_contact",
        tool_call_id: "link-1",
      }),
    ];
    expect(latestContactIncompleteMissingFields(messages)).toBeNull();
    expect(latestMeetingMutationError(messages)).toBe("Contact incomplete");
  });
});

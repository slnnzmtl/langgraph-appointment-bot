import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command, Overwrite } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { serviceChangedNoticeUk } from "../../shared/clinic-constants.js";
import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import {
  createAgentCommandPrepareNode,
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../booking-draft.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";

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

  it("routes incomplete-contact booking errors to the model without retrying the mutation", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName"] }],
      },
      bookingDraft: canonicalBookingDraft({ contactId: "c-1" }),
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
    )).toBe("booking__llm");
    expect(routeAfterAgentLlm(
      { ...state, agentMessages: [...state.agentMessages, new AIMessage("Назвіть, будь ласка, прізвище.")] },
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__finalize");
  });

  it("does not rebuild a reschedule after authorization failure until identity is refreshed", async () => {
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
    )).toBe("booking__llm");
    expect(routeAfterAgentPrepare(afterFailure, "booking__llm", "booking__command_prepare"))
      .toBe("booking__llm");
  });
});

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setTrackEventForTests } from "../../analytics/track.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { BOOKING_RUNTIME_TOOL_NAMES } from "../../tools/index.js";
import {
  bookingCommandContinuesAfterTools,
  bookingTurnNeedsCommandPreparation,
  createAgentCommandPrepareNode,
  isPendingChatConfirmationReplay,
  shouldRearmCancelAfterChatOther,
} from "../agent-loop/command-prepare.js";
import { coerceAvailabilityToolCalls } from "../agent-loop/tool-call-coercion.js";
import type { BookingDraft } from "../booking-draft.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";
import {
  classifyPhoneLookupResult,
  resolveContactCommand,
} from "../contact-command.js";
import type { ClinicState } from "../state.js";

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

const acceptedService = {
  status: "accepted" as const,
  service: {
    id: CONSULTATION_SERVICE_ID,
    name: "Консультація",
    durationMinutes: 30,
    source: "catalog" as const,
  },
};

const slot = {
  slotId: "slot-14",
  label: "14:00",
  dateStart: "2026-09-10T14:00:00",
  dateEnd: "2026-09-10T14:30:00",
};

const readyCreateDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft => ({
  ...createEmptyBookingDraft(),
  version: 4,
  mode: "create",
  phase: "ready",
  serviceAcceptance: acceptedService,
  selectedDate: "2026-09-10",
  selectedSlot: slot,
  note: { status: "skipped" },
  contactId: "c-1",
  ...overrides,
});

const ownedContact = {
  ownership: "telegram" as const,
  contacts: [{
    id: "c-1",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    missingFields: [] as string[],
  }],
};

const freshSlotsToolMessage = (
  toolCallId = "slots-1",
  extras: Record<string, unknown> = {},
): ToolMessage =>
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
      query: {
        kind: "exact",
        date: "2026-09-10",
        coverageComplete: true,
      },
      ...extras,
    }),
    name: "present_availability_slots",
    tool_call_id: toolCallId,
  });

const lastToolCall = (update: { agentMessages?: unknown }) => {
  const messages = (update.agentMessages as Overwrite<AIMessage[]>).value;
  const last = messages.at(-1);
  expect(last).toBeInstanceOf(AIMessage);
  return (last as AIMessage).tool_calls?.[0];
};

const lastAi = (update: { agentMessages?: unknown }): AIMessage => {
  const messages = (update.agentMessages as Overwrite<AIMessage[]>).value;
  const last = messages.at(-1);
  expect(last).toBeInstanceOf(AIMessage);
  return last as AIMessage;
};

describe("command_prepare runtime authority", () => {
  const commandPrepare = createAgentCommandPrepareNode("booking");
  const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];

  afterEach(() => {
    setTrackEventForTests(null);
    tracked.length = 0;
  });

  const captureRuntimeToolEvents = () => {
    setTrackEventForTests((name, props) => {
      tracked.push({ name, props });
    });
  };

  it("revalidates then creates from a complete draft without an LLM mutation", async () => {
    captureRuntimeToolEvents();
    const base = clinicState({
      contactContext: ownedContact,
      bookingDraft: readyCreateDraft(),
      agentMessages: [],
    });
    expect(bookingTurnNeedsCommandPreparation(base)).toBe(true);

    const revalidate = await commandPrepare(base);
    expect(lastToolCall(revalidate)).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "exact",
        date: "2026-09-10",
        forceRefresh: true,
      },
    });
    expect(lastAi(revalidate).additional_kwargs).toMatchObject({
      runtimeToolOrigin: "command_prepare",
    });
    expect(tracked).toContainEqual({
      name: "booking_runtime_tool",
      props: {
        tool: "present_availability_slots",
        origin: "command_prepare",
        action: "create_revalidate",
      },
    });
    expect(JSON.stringify(tracked)).not.toMatch(/\+380|Ada|Lovelace|phoneNumber/);

    const afterSlots = clinicState({
      contactContext: ownedContact,
      bookingDraft: revalidate.bookingDraft as BookingDraft,
      agentMessages: [
        ...(revalidate.agentMessages as Overwrite<AIMessage[]>).value,
        freshSlotsToolMessage("booking_revalidate_4"),
      ],
    });
    expect(bookingCommandContinuesAfterTools(afterSlots)).toBe(true);

    const create = await commandPrepare(afterSlots);
    expect(lastToolCall(create)).toMatchObject({
      name: "create_meeting",
      args: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(create.bookingDraft?.pendingCommand?.action).toBe("create");
    expect(create.pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "create",
    });
    expect(tracked).toContainEqual({
      name: "booking_runtime_tool",
      props: {
        tool: "create_meeting",
        origin: "command_prepare",
        action: "create",
      },
    });
  });

  it("injects reschedule_meeting after fresh availability validates the slot", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "m-1",
        name: "Консультація - Ada",
        dateStart: "2026-08-17 11:00:00",
        dateEnd: "2026-08-17 11:30:00",
      },
    });
    const withSlot = reduceBookingDraft(
      reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" }),
      {
        type: "slot_selected",
        slot,
      },
    );
    const afterSlots = clinicState({
      bookingDraft: withSlot,
      agentMessages: [
        freshSlotsToolMessage("slots-1", { excludeMeetingIds: ["m-1"] }),
      ],
    });
    expect(bookingTurnNeedsCommandPreparation(afterSlots)).toBe(true);
    const update = await commandPrepare(afterSlots);
    expect(lastToolCall(update)).toMatchObject({
      name: "reschedule_meeting",
      args: {
        meetingId: "m-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(update.pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "reschedule",
    });
  });

  it("injects cancel_meeting from a seeded pending cancel without an LLM tool_call", async () => {
    captureRuntimeToolEvents();
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "command_prepared",
      command: {
        action: "cancel",
        payload: { meetingId: "m-1", name: "Консультація" },
      },
    });
    const update = await commandPrepare(clinicState({
      bookingDraft: draft,
      bookingContext: {
        meetings: [{
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        }],
        dateFrom: "2026-08-11",
      },
      agentMessages: [],
    }));
    expect(lastToolCall(update)).toMatchObject({
      name: "cancel_meeting",
      args: { meetingId: "m-1" },
    });
    expect(update.pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
    expect(tracked).toContainEqual({
      name: "booking_runtime_tool",
      props: {
        tool: "cancel_meeting",
        origin: "command_prepare",
        action: "cancel",
      },
    });
  });

  it("does not replay create chat-other via confirmationGiven free text", async () => {
    const state = clinicState({
      messages: [new HumanMessage("Так")],
      bookingDraft: readyCreateDraft({
        phase: "confirming",
        pendingCommand: null,
        selectedSlot: null,
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
            userReply: "Яка адреса?",
          }),
          name: "create_meeting",
          tool_call_id: "create-1",
        }),
        new AIMessage("Клініка за адресою…"),
      ],
    });
    expect(shouldRearmCancelAfterChatOther(state)).toBe(false);
    expect(bookingTurnNeedsCommandPreparation(state)).toBe(false);
    const update = await commandPrepare(state);
    expect(update.agentMessages).toBeUndefined();
    expect(isPendingChatConfirmationReplay(
      {
        ...state,
        bookingDraft: readyCreateDraft({
          pendingCommand: {
            action: "create",
            payload: { serviceId: CONSULTATION_SERVICE_ID },
          },
        }),
      },
      "create",
      { confirmationGiven: true },
    )).toBe(true);
  });

  it("injects nearest availability after service accept with no DATE snapshot", async () => {
    const state = clinicState({
      bookingDraft: readyCreateDraft({
        selectedDate: null,
        selectedSlot: null,
        phase: "date",
        contactId: "c-1",
        note: { status: "unasked" },
      }),
      contactContext: ownedContact,
      availabilityContext: null,
      agentMessages: [],
    });
    expect(bookingTurnNeedsCommandPreparation(state)).toBe(true);
    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "nearest",
        forceRefresh: true,
        durationMinutes: 30,
      },
    });
  });

  it("REPLACE accept injects cancel_meeting from runtime", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: {
        id: "m-1",
        name: "Консультація",
        dateStart: "2026-08-17 11:00:00",
        dateEnd: "2026-08-17 11:30:00",
      },
    });
    const update = await commandPrepare(clinicState({
      messages: [new HumanMessage("Скасувати")],
      bookingDraft: draft,
      bookingContext: {
        meetings: [{
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        }],
        dateFrom: "2026-08-11",
      },
      pendingInteraction: {
        kind: "visit_select",
        stage: "replacement",
        meetingId: "m-1",
        meetings: [{
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        }],
        choices: [
          { id: "cancel_existing", label: "Скасувати" },
          { id: "decline", label: "Ні, дякую" },
        ],
      },
      agentMessages: [new HumanMessage("Скасувати")],
    }));
    expect(lastToolCall(update)).toMatchObject({
      name: "cancel_meeting",
      args: { meetingId: "m-1" },
    });
    expect(update.pendingCancellationPurpose).toBe("replacement");
  });
});

describe("ContactCommand decisions", () => {
  const commandPrepare = createAgentCommandPrepareNode("booking");

  const detailsDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft =>
    readyCreateDraft({
      contactId: null,
      contactDetails: {
        phoneNumber: "+380501112233",
        firstName: "Олена",
        lastName: "Коваль",
      },
      phoneLookupEvidence: null,
      ...overrides,
    });

  it("looks up an accepted phone when evidence is missing", async () => {
    const state = clinicState({
      bookingDraft: detailsDraft(),
      agentMessages: [],
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "lookup",
      phoneNumber: "+380501112233",
    });
    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "find_contact_by_phone",
      args: { phoneNumber: "+380501112233" },
    });
  });

  it("creates only after none evidence for the exact accepted phone", async () => {
    const state = clinicState({
      bookingDraft: detailsDraft({
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "none",
          contactIds: [],
        },
      }),
    });
    expect(resolveContactCommand(state)).toMatchObject({
      action: "create",
      details: {
        phoneNumber: "+380501112233",
        firstName: "Олена",
        lastName: "Коваль",
      },
    });
    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "create_contact",
      args: {
        phoneNumber: "+380501112233",
        firstName: "Олена",
        lastName: "Коваль",
      },
    });
  });

  it("links a single linkable phone match", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "phone",
        contacts: [{
          id: "c-phone",
          firstName: "Олена",
          lastName: "Коваль",
          phoneNumber: "+380501112233",
          cTelegram: null,
          missingFields: [],
        }],
      },
      bookingDraft: detailsDraft({
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "single_linkable",
          contactIds: ["c-phone"],
        },
      }),
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "link",
      contactId: "c-phone",
    });
    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "link_telegram_to_contact",
      args: { contactId: "c-phone" },
    });
  });

  it("updates an owned incomplete contact from preserved draft details", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-1",
          firstName: "",
          lastName: "",
          phoneNumber: "+380501112233",
          missingFields: ["firstName", "lastName"],
        }],
      },
      bookingDraft: readyCreateDraft({
        contactId: "c-1",
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
          lastName: "Коваль",
        },
      }),
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "update",
      contactId: "c-1",
      fields: { firstName: "Олена", lastName: "Коваль" },
    });
    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "update_contact",
      args: {
        contactId: "c-1",
        firstName: "Олена",
        lastName: "Коваль",
      },
    });
  });

  it("reopens phone for occupied lookup evidence and never links or creates", () => {
    const state = clinicState({
      bookingDraft: detailsDraft({
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "occupied",
          contactIds: ["c-other"],
        },
      }),
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "request_field",
      field: "phoneNumber",
      occupied: true,
    });
    expect(bookingTurnNeedsCommandPreparation(state)).toBe(false);
  });

  it("fails closed on ambiguous phone candidates", () => {
    const evidence = classifyPhoneLookupResult(
      [
        { id: "c-1", phoneNumber: "+380501112233", cTelegram: null },
        { id: "c-2", phoneNumber: "+380501112233", cTelegram: null },
      ],
      "+380501112233",
    );
    expect(evidence.result).toBe("ambiguous");
    const state = clinicState({
      bookingDraft: detailsDraft({ phoneLookupEvidence: evidence }),
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "request_field",
      field: "phoneNumber",
      occupied: true,
    });
  });

  it("continues the contact chain after a successful lookup without returning to the LLM", () => {
    const afterLookup = clinicState({
      bookingDraft: detailsDraft({
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "none",
          contactIds: [],
        },
      }),
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "lookup-1",
            name: "find_contact_by_phone",
            args: { phoneNumber: "+380501112233" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ contacts: [] }),
          name: "find_contact_by_phone",
          tool_call_id: "lookup-1",
        }),
      ],
    });
    expect(bookingCommandContinuesAfterTools(afterLookup)).toBe(true);
    expect(resolveContactCommand(afterLookup).action).toBe("create");
  });

  it("continues after link when draft still has accepted fields for update", () => {
    const afterLink = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-phone",
          firstName: "",
          lastName: "",
          phoneNumber: "+380501112233",
          missingFields: ["firstName", "lastName"],
        }],
      },
      bookingDraft: readyCreateDraft({
        contactId: "c-phone",
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
          lastName: "Коваль",
        },
      }),
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "link-1",
            name: "link_telegram_to_contact",
            args: { contactId: "c-phone" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ id: "c-phone" }),
          name: "link_telegram_to_contact",
          tool_call_id: "link-1",
        }),
      ],
    });
    expect(resolveContactCommand(afterLink).action).toBe("update");
    expect(bookingCommandContinuesAfterTools(afterLink)).toBe(true);
  });
});

describe("booking LLM tool surface coercion", () => {
  const informational = new Set(["list_services", "get_service", "get_working_time"]);

  it("drops leaked and native runtime-owned tool calls", () => {
    for (const name of BOOKING_RUNTIME_TOOL_NAMES) {
      const native = new AIMessage({
        content: "",
        tool_calls: [{
          id: `native-${name}`,
          name,
          args: { confirmationGiven: true, phoneNumber: "+380501112233" },
          type: "tool_call",
        }],
      });
      const coerced = coerceAvailabilityToolCalls(
        native,
        clinicState(),
        "booking",
        informational,
      );
      expect(coerced.tool_calls ?? []).toEqual([]);
    }
  });

  it("keeps informational tool calls and never synthesizes availability", () => {
    const response = new AIMessage({
      content: "Підберу найближчі дати.",
      tool_calls: [{
        id: "svc-1",
        name: "list_services",
        args: {},
        type: "tool_call",
      }],
    });
    const coerced = coerceAvailabilityToolCalls(
      response,
      clinicState({
        bookingDraft: readyCreateDraft(),
        messages: [new HumanMessage("Так")],
      }),
      "booking",
      informational,
    );
    expect(coerced.tool_calls).toEqual([
      expect.objectContaining({ name: "list_services" }),
    ]);
    expect(coerced.tool_calls?.some((call) => call.name === "present_availability_slots"))
      .toBe(false);
  });

  it("hydrates leaked informational XML only", () => {
    const response = new AIMessage(
      "text <call:default_api:list_services{}></call:default_api:list_services>"
      + "<call:default_api:create_meeting{confirmationGiven: true}></call:default_api:create_meeting>",
    );
    const coerced = coerceAvailabilityToolCalls(
      response,
      clinicState(),
      "booking",
      informational,
    );
    expect(coerced.tool_calls).toEqual([
      expect.objectContaining({ name: "list_services" }),
    ]);
  });
});

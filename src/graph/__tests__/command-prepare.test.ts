import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command, Overwrite } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";

import { setTrackEventForTests } from "../../analytics/track.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { BOOKING_RUNTIME_TOOL_NAMES } from "../../tools/index.js";
import {
  bookingOutcomeNeedsPrepare,
  isPendingChatConfirmationReplay,
  resolveBookingCommand,
  shouldRearmCancelAfterChatOther,
} from "../agent-loop/booking-command.js";
import {
  commandFromBookingOutcome,
  createAgentCommandPrepareNode,
  defaultCommandPrepareNodes,
} from "../agent-loop/command-prepare.js";
import {
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/routing.js";
import { BOOKING_REPLACE_MENU } from "../../shared/clinic-constants.js";
import { openVisitReplacementInteraction } from "../booking-session.js";
import { coerceAvailabilityToolCalls } from "../agent-loop/tool-call-coercion.js";
import type { BookingDraft } from "../booking-draft.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";
import {
  classifyPhoneLookupResult,
  resolveContactCommand,
} from "../contact-command.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";

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

const asUpdate = (result: Command | ClinicStateUpdate): ClinicStateUpdate =>
  result instanceof Command ? (result.update as ClinicStateUpdate) : result;

const lastToolCall = (result: Command | ClinicStateUpdate) => {
  const update = asUpdate(result);
  const messages = (update.agentMessages as Overwrite<AIMessage[]>).value;
  const last = messages.at(-1);
  expect(last).toBeInstanceOf(AIMessage);
  return (last as AIMessage).tool_calls?.[0];
};

const lastAi = (result: Command | ClinicStateUpdate): AIMessage => {
  const update = asUpdate(result);
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(base))).toBe(true);
    expect(resolveBookingCommand(base)).toMatchObject({
      kind: "execute",
      toolCall: { name: "present_availability_slots" },
    });

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

    const revalidateUpdate = asUpdate(revalidate);
    const afterSlots = clinicState({
      contactContext: ownedContact,
      bookingDraft: revalidateUpdate.bookingDraft as BookingDraft,
      agentMessages: [
        ...(revalidateUpdate.agentMessages as Overwrite<AIMessage[]>).value,
        freshSlotsToolMessage("booking_revalidate_4"),
      ],
    });
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(afterSlots))).toBe(true);
    expect(resolveBookingCommand(afterSlots)).toMatchObject({
      kind: "execute",
      toolCall: { name: "create_meeting" },
    });

    const create = await commandPrepare(afterSlots);
    const createUpdate = asUpdate(create);
    expect(lastToolCall(create)).toMatchObject({
      name: "create_meeting",
      args: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(createUpdate.bookingDraft?.pendingCommand?.action).toBe("create");
    expect(createUpdate.pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "create",
    });
    expect(create).toBeInstanceOf(Command);
    expect(create.goto).toEqual(["booking__tools"]);
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(afterSlots))).toBe(true);
    const update = await commandPrepare(afterSlots);
    expect(lastToolCall(update)).toMatchObject({
      name: "reschedule_meeting",
      args: {
        meetingId: "m-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(asUpdate(update).pendingInteraction).toMatchObject({
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
    expect(asUpdate(update).pendingInteraction).toMatchObject({
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(state))).toBe(false);
    const update = await commandPrepare(state);
    expect(asUpdate(update).agentMessages).toBeUndefined();
    expect(update).toBeInstanceOf(Command);
    expect(update.goto).toEqual(["booking__llm"]);
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(state))).toBe(true);
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
    expect(asUpdate(update).pendingCancellationPurpose).toBe("replacement");
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

  it("revalidates none evidence with a same-phone lookup before create", async () => {
    const state = clinicState({
      bookingDraft: detailsDraft({
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "none",
          contactIds: [],
        },
      }),
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

  it("requests firstName after none evidence when names are still missing", () => {
    const state = clinicState({
      bookingDraft: detailsDraft({
        contactDetails: { phoneNumber: "+380501112233" },
        phoneLookupEvidence: {
          phoneNumber: "+380501112233",
          result: "none",
          contactIds: [],
        },
      }),
    });
    expect(resolveContactCommand(state)).toEqual({
      action: "request_field",
      field: "firstName",
    });
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(state))).toBe(true);
    expect(resolveBookingCommand(state)).toMatchObject({
      kind: "render",
      reason: "contact_field",
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(state))).toBe(true);
    expect(resolveBookingCommand(state)).toMatchObject({
      kind: "render",
      reason: "contact_field",
    });
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(afterLookup))).toBe(true);
    expect(resolveContactCommand(afterLookup).action).toBe("create");
  });

  it("stops the contact chain when find_contact_by_phone returns an error", () => {
    const afterLookup = clinicState({
      bookingDraft: detailsDraft({ phoneLookupEvidence: null }),
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "lookup-err",
            name: "find_contact_by_phone",
            args: { phoneNumber: "+380501112233" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          name: "find_contact_by_phone",
          tool_call_id: "lookup-err",
        }),
      ],
    });
    expect(resolveContactCommand(afterLookup).action).toBe("none");
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(afterLookup))).toBe(false);
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
    expect(bookingOutcomeNeedsPrepare(resolveBookingCommand(afterLink))).toBe(true);
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

describe("DDD-255 deterministic booking transitions", () => {
  const commandPrepare = createAgentCommandPrepareNode("booking");

  const snapshot = {
    days: [
      {
        date: "2026-10-03",
        slots: [{
          id: "a",
          label: "10:00",
          dateStart: "2026-10-03T10:00:00",
          dateEnd: "2026-10-03T10:30:00",
        }],
      },
      {
        date: "2026-10-05",
        slots: [{
          id: "b",
          label: "11:00",
          dateStart: "2026-10-05T11:00:00",
          dateEnd: "2026-10-05T11:30:00",
        }],
      },
    ],
    stepMinutes: 30,
    query: {
      kind: "nearest" as const,
      rangeFrom: "2026-10-03",
      rangeThrough: "2026-10-05",
      coverageComplete: true,
    },
  };

  it.each(["Інша дата", "Another date", "раніше"] as const)(
    "pages availability for %s with cursor anchors",
    async (label) => {
      const state = clinicState({
        messages: [new HumanMessage(label)],
        bookingDraft: readyCreateDraft({
          selectedDate: "2026-10-03",
          selectedSlot: null,
          phase: "date",
          note: { status: "unasked" },
          contactId: null,
        }),
        availabilityContext: snapshot,
        availabilityCursor: {
          firstDate: "2026-10-03",
          lastDate: "2026-10-05",
          query: snapshot.query,
        },
        agentMessages: [],
      });
      const outcome = resolveBookingCommand(state);
      expect(outcome.kind).toBe("execute");
      if (outcome.kind !== "execute") {
        return;
      }
      expect(outcome.toolCall.name).toBe("present_availability_slots");
      if (label === "раніше") {
        expect(outcome.toolCall.args).toMatchObject({
          direction: "earlier",
          beforeDate: "2026-10-03",
        });
      } else {
        expect(outcome.toolCall.args).toMatchObject({
          direction: "later",
          afterDate: "2026-10-05",
        });
      }
      const cmd = await commandPrepare(state);
      expect(cmd).toBeInstanceOf(Command);
      expect(cmd.goto).toEqual(["booking__tools"]);
    },
  );

  it("does not emit a second page in the same turn", () => {
    const state = clinicState({
      messages: [new HumanMessage("Інша дата")],
      bookingDraft: readyCreateDraft({
        selectedDate: "2026-10-03",
        selectedSlot: null,
        phase: "date",
        note: { status: "unasked" },
        contactId: null,
      }),
      availabilityContext: snapshot,
      availabilityCursor: {
        firstDate: "2026-10-03",
        lastDate: "2026-10-05",
        query: snapshot.query,
      },
      agentMessages: [
        freshSlotsToolMessage("page-1", {
          query: { kind: "later", afterDate: "2026-10-05", coverageComplete: true },
        }),
      ],
    });
    expect(resolveBookingCommand(state).kind).toBe("continue_llm");
  });

  it("routes note-required as render without a tool call", async () => {
    const state = clinicState({
      contactContext: ownedContact,
      bookingDraft: readyCreateDraft({
        note: { status: "awaiting" },
      }),
      agentMessages: [
        freshSlotsToolMessage("slots-1"),
      ],
    });
    const outcome = resolveBookingCommand(state);
    expect(outcome).toMatchObject({
      kind: "render",
      reason: "note_required",
    });
    const cmd = await commandPrepare(state);
    expect(cmd.goto).toEqual(["booking__interaction_render"]);
    expect(asUpdate(cmd).pendingInteraction).toMatchObject({ kind: "visit_note" });
    expect(asUpdate(cmd).agentMessages).toBeUndefined();
  });

  it("fails closed for unstamped legacy runtime calls in tools", async () => {
    const { createAgentToolsNode } = await import("../agent-loop/tools.js");
    const { tool } = await import("@langchain/core/tools");
    const { z } = await import("zod");
    const invoked: unknown[] = [];
    const link = tool(async (input) => {
      invoked.push(input);
      return JSON.stringify({ id: "c-1" });
    }, {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([link], "booking")(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "link-legacy",
              name: "link_telegram_to_contact",
              args: { contactId: "c-1" },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    const messages = update.agentMessages instanceof Overwrite
      ? update.agentMessages.value
      : update.agentMessages;
    expect((messages as AIMessage[]).some((message) => message instanceof ToolMessage)).toBe(false);
  });

  it("keeps mutation_confirm on the execute update before tools", async () => {
    const afterSlots = clinicState({
      contactContext: ownedContact,
      bookingDraft: readyCreateDraft({
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: CONSULTATION_SERVICE_ID,
            contactId: "c-1",
            dateStart: slot.dateStart,
            dateEnd: slot.dateEnd,
          },
        },
      }),
      agentMessages: [
        freshSlotsToolMessage("booking_revalidate_4"),
      ],
    });
    const cmd = await commandPrepare(afterSlots);
    expect(cmd.goto).toEqual(["booking__tools"]);
    expect(asUpdate(cmd).pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "create",
    });
    expect(lastToolCall(cmd)?.name).toBe("create_meeting");
  });

  it("requires fresh revalidation before create and reschedule", () => {
    const createReady = clinicState({
      contactContext: ownedContact,
      bookingDraft: readyCreateDraft(),
      agentMessages: [],
    });
    expect(resolveBookingCommand(createReady)).toMatchObject({
      kind: "execute",
      toolCall: { name: "present_availability_slots" },
    });

    const rescheduleDraft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "m-1",
        name: "Консультація",
        dateStart: "2026-08-17 11:00:00",
        dateEnd: "2026-08-17 11:30:00",
      },
    });
    const withSlot = reduceBookingDraft(
      reduceBookingDraft(rescheduleDraft, { type: "date_selected", date: "2026-09-10" }),
      { type: "slot_selected", slot },
    );
    expect(resolveBookingCommand(clinicState({
      bookingDraft: withSlot,
      agentMessages: [],
    }))).toMatchObject({
      kind: "execute",
      toolCall: { name: "present_availability_slots" },
    });
  });
});

describe("DDD-261 unified booking transition planner", () => {
  const commandPrepare = createAgentCommandPrepareNode("booking");
  const nodes = defaultCommandPrepareNodes("booking");
  const tracked: Array<{ name: string; props: Record<string, unknown> }> = [];

  afterEach(() => {
    setTrackEventForTests(null);
    tracked.length = 0;
  });

  it("routes continue_llm with an update through command_prepare (replacement decline)", async () => {
    const meeting = {
      id: "existing-1",
      name: "Консультація - Ada",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    };
    const state = clinicState({
      messages: [new HumanMessage(BOOKING_REPLACE_MENU[1])],
      bookingContext: { meetings: [meeting], dateFrom: "2026-08-11" },
      bookingDraft: readyCreateDraft({
        phase: "service",
        selectedDate: null,
        selectedSlot: null,
        contactId: null,
        note: { status: "unasked" },
        replacement: { meeting, status: "offered" },
      }),
      pendingInteraction: openVisitReplacementInteraction(meeting),
      agentMessages: [],
    });
    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("continue_llm");
    expect(outcome.update).toMatchObject({
      bookingDraft: null,
      pendingInteraction: null,
    });
    expect(bookingOutcomeNeedsPrepare(outcome)).toBe(true);
    expect(routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"))
      .toBe("booking__command_prepare");

    const cmd = await commandPrepare(state);
    expect(cmd.goto).toEqual(["booking__llm"]);
    expect(asUpdate(cmd)).toMatchObject({
      bookingDraft: null,
      pendingInteraction: null,
    });
    expect(asUpdate(cmd).agentMessages).toBeInstanceOf(Overwrite);
  });

  it("applies continue_tools tape rewrite before tools", async () => {
    const state = clinicState({
      messages: [new HumanMessage("яка адреса?")],
      bookingDraft: readyCreateDraft({
        phase: "confirming",
        pendingCommand: {
          action: "cancel",
          payload: { meetingId: "m-1", name: "Консультація" },
        },
      }),
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
            userReply: "яка адреса?",
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-1",
        }),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "cancel-rearm",
              name: "cancel_meeting",
              args: { meetingId: "m-1" },
              type: "tool_call",
            },
            {
              id: "info-1",
              name: "get_working_time",
              args: {},
              type: "tool_call",
            },
          ],
        }),
      ],
    });
    // Mixed mutation + informational: strip mutation, keep informational.
    expect(shouldRearmCancelAfterChatOther(state)).toBe(true);
    const outcome = resolveBookingCommand(state);
    expect(outcome.kind).toBe("continue_tools");
    expect(outcome.update?.agentMessages).toBeInstanceOf(Overwrite);
    const rewritten = (outcome.update!.agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...rewritten].reverse().find((m) => m instanceof AIMessage) as AIMessage;
    expect(lastAi.tool_calls?.map((c) => c.name)).toEqual(["get_working_time"]);
    expect(bookingOutcomeNeedsPrepare(outcome)).toBe(true);

    const cmd = commandFromBookingOutcome(state, outcome, nodes);
    expect(cmd.goto).toEqual(["booking__tools"]);
    const applied = (asUpdate(cmd).agentMessages as Overwrite<AIMessage[]>).value;
    const appliedAi = [...applied].reverse().find((m) => m instanceof AIMessage) as AIMessage;
    expect(appliedAi.tool_calls?.map((c) => c.name)).toEqual(["get_working_time"]);
  });

  it("does not emit telemetry when routers call the planner", () => {
    setTrackEventForTests((name, props) => {
      tracked.push({ name, props });
    });
    const state = clinicState({
      contactContext: ownedContact,
      bookingDraft: readyCreateDraft(),
      agentMessages: [],
    });
    resolveBookingCommand(state);
    resolveBookingCommand(state);
    routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare");
    routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    );
    expect(tracked).toEqual([]);

    const cmd = commandFromBookingOutcome(state, resolveBookingCommand(state), nodes);
    expect(cmd.goto).toEqual(["booking__tools"]);
    expect(tracked).toContainEqual({
      name: "booking_runtime_tool",
      props: {
        tool: "present_availability_slots",
        origin: "command_prepare",
        action: "create_revalidate",
      },
    });
    expect(tracked.filter((e) => e.name === "booking_runtime_tool")).toHaveLength(1);
  });

  it("finalizes unresolved HITL mutation calls instead of the informational-tool path", () => {
    const state = clinicState({
      messages: [new HumanMessage("скільки коштує?")],
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
            userReply: "скільки коштує?",
          }),
          name: "create_meeting",
          tool_call_id: "create-1",
        }),
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-leak",
            name: "create_meeting",
            args: { confirmationGiven: true },
            type: "tool_call",
          }],
        }),
      ],
      stepCount: 2,
    });
    expect(resolveBookingCommand(state).kind).toBe("continue_llm");
    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__finalize");
  });

  it("prepares the original create command after create_pending revalidation", async () => {
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
      },
      idempotencyKey: "create:replacement",
      expiresAt: Date.now() + 60_000,
    };
    const state = clinicState({
      contactContext: ownedContact,
      messages: [new HumanMessage("Скасувати")],
      bookingContext: {
        meetings: [{
          id: "existing-1",
          name: "Консультація",
          dateStart: "2026-08-17 11:00:00",
          dateEnd: "2026-08-17 11:30:00",
        }],
        dateFrom: "2026-08-11",
      },
      bookingDraft: {
        ...createEmptyBookingDraft(),
        version: 9,
        mode: "create",
        phase: "confirming",
        serviceAcceptance: {
          status: "accepted",
          service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        },
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
          meeting: { id: "existing-1" },
          status: "create_pending",
          originalCommand,
        },
      },
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            days: [{
              date: "2026-10-17",
              slots: [{
                id: "slot-1130",
                label: "11:30",
                dateStart: "2026-10-17T11:30:00",
                dateEnd: "2026-10-17T12:00:00",
              }],
            }],
            stepMinutes: 30,
            query: {
              kind: "exact",
              date: "2026-10-17",
              coverageComplete: true,
            },
          }),
          name: "present_availability_slots",
          tool_call_id: "slots-1",
        }),
        new AIMessage("Готую запис"),
      ],
    });
    expect(resolveBookingCommand(state)).toMatchObject({
      kind: "execute",
      toolCall: {
        name: "create_meeting",
        args: originalCommand.payload,
      },
    });
    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const update = await commandPrepare(state);
    expect(lastToolCall(update)).toMatchObject({
      name: "create_meeting",
      args: originalCommand.payload,
    });
    expect(asUpdate(update).bookingDraft?.pendingCommand?.action).toBe("create");
    expect(lastToolCall(update)?.name).not.toBe("cancel_meeting");
  });
});

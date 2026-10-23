import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Command, interrupt, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileClinicGraph } from "../compile.js";
import { acceptedCreateDraft, bookingIntegrationSnapshot } from "./agent-loop-booking-integration-harness.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";
import { createContactTools } from "../../tools/contact-tools.js";
import type { InterpretBookingTurn } from "../agent-loop/booking-turn-interpreter.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";

const bookingAgent: ClinicAgentDefinition = {
  id: "booking",
  name: "Booking",
  description: "Books appointments",
  systemPrompt: "book",
  maxSteps: 8,
};
const faqAgent: ClinicAgentDefinition = {
  id: "faq",
  name: "FAQ",
  description: "Answers clinic questions",
  systemPrompt: "faq",
  maxSteps: 4,
};

const createGraph = (
  writeResult: (args: Record<string, unknown>) => Promise<string>,
  options: { bookingTools?: ReturnType<typeof createContactTools>; interpretBookingTurn?: InterpretBookingTurn } = {},
) => {
  const availabilityArgs: Record<string, unknown>[] = [];
  const createMeeting = tool(async (args) => {
    const decision = interrupt({ type: "confirm_booking", draft: args }) as {
      confirmed?: boolean;
    };
    return decision?.confirmed === true
      ? writeResult(args as Record<string, unknown>)
      : JSON.stringify({ cancelled: true });
  }, {
    name: "create_meeting",
    description: "Test-only booking mutation with the production interrupt contract",
    schema: z.object({}).passthrough(),
  });
  const presentAvailability = tool(async (args) => {
    availabilityArgs.push(args as Record<string, unknown>);
    return JSON.stringify({
      ...bookingIntegrationSnapshot,
      serviceId: "svc-1",
      query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
    });
  }, {
    name: "present_availability_slots",
    description: "Test availability revalidation",
    schema: z.object({}).passthrough(),
  });
  const checkpointer = new MemorySaver();
  const { graph } = compileClinicGraph({
    specialists: { faq: faqAgent, booking: bookingAgent },
    agentTools: { faq: [], booking: [presentAvailability, createMeeting, ...(options.bookingTools ?? [])] },
    agentModel: {
      bindTools: () => ({ invoke: async () => new AIMessage("ok") }),
    } as unknown as BaseChatModel,
    supervisorLlm: {
      bindRoutingTools: () => ({ invoke: async () => ({ next: "booking" }) }),
      withStructuredOutput: () => ({ invoke: async () => ({ text: "Your appointment was processed." }) }),
    } as unknown as ILLMConnector,
    interpretBookingTurn: options.interpretBookingTurn ?? (async () => ({})),
    assignedUserId: "user-1",
    formatSystemMetadata: () => "META",
    messageHistoryMaxTokens: 6_000,
    checkpointer,
  });
  return { graph, availabilityArgs };
};

const readyDraft = () => acceptedCreateDraft({
  serviceAcceptance: {
    status: "accepted",
    service: { id: "svc-1", name: "Процедура", source: "catalog" },
  },
  selectedDate: "2026-09-10",
  selectedSlot: {
    dateStart: "2026-09-10T14:00:00",
    dateEnd: "2026-09-10T14:30:00",
    label: "14:00",
  },
  note: { status: "skipped" },
  contactId: "contact-1",
  contactDetails: {
    phoneNumber: "+380501112233",
    firstName: "Ada",
    lastName: "Lovelace",
  },
  slotProvenance: "availability_tool",
  slotEvidence: { snapshotId: "snapshot-1", serviceId: "svc-1" },
});

const initialState = () => ({
  messages: [new HumanMessage("Continue booking")],
  bookingDraft: readyDraft(),
  bookingSchemaVersion: 2,
  patientLocale: "en" as const,
  availabilityContext: { ...bookingIntegrationSnapshot, serviceId: "svc-1" },
});

describe("compileClinicGraph booking HITL", () => {
  it.each(["Так", "Записатись"])("accepts a verified FAQ highlight via %s without a second service confirmation", async (acceptLabel) => {
    const interpretBookingTurn: InterpretBookingTurn = async (input) =>
      interpretBookingTurnDeterministic(input);
    const { graph, availabilityArgs } = createGraph(async () => JSON.stringify({ id: "meeting-1" }), {
      interpretBookingTurn,
    });
    const config = { configurable: { thread_id: "compiled-faq-highlight-book" } };
    const opened = await graph.invoke({
      messages: [new HumanMessage(acceptLabel)],
      bookingDraft: null,
      bookingSchemaVersion: 2,
      patientLocale: "uk",
      pendingInteraction: {
        kind: "service_candidate",
        owner: "faq",
        utterance: "procedure",
        choices: [{ id: "svc-1", label: "Peel", serviceIds: ["svc-1"] }],
      },
      servicesContext: {
        list: [{ id: "svc-1", name: "Peel CRM", duration: 30 }],
        fetchedAt: Date.now(),
      },
    } as never, config);
    const checkpoint = await graph.getState(config);

    expect(checkpoint.values.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: "svc-1", name: "Peel CRM", durationMinutes: 30 },
    });
    expect(checkpoint.values.pendingInteraction?.kind).toBe("date_select");
    expect(checkpoint.values.pendingInteraction?.kind).not.toBe("service_confirm");
    expect(availabilityArgs[0]).toMatchObject({ durationMinutes: 30 });
    const toolCalls = opened.agentMessages?.flatMap((message) =>
      "tool_calls" in message ? message.tool_calls ?? [] : [],
    ) ?? [];
    expect(toolCalls.some((call) => call.name === "create_meeting")).toBe(false);
  });

  it("collects both names, verifies the CRM repair, then opens meeting confirmation", async () => {
    const contact = {
      id: "contact-1",
      phoneNumber: "+380501112233",
      firstName: "",
      lastName: "",
    };
    const crmCalls: string[] = [];
    const contactTools = createContactTools({
      callTool: async (name, args) => {
        crmCalls.push(name);
        if (name === "update_entity") {
          Object.assign(contact, args.data);
          return "Successfully updated Contact record with ID: contact-1";
        }
        if (name === "get_entity") return { ...contact };
        return { ok: true };
      },
    });
    const interpretBookingTurn: InterpretBookingTurn = async ({ rawText }) =>
      rawText === "Ada"
        ? { contactFacts: { firstName: "Ada" } }
        : rawText === "Lovelace"
          ? { contactFacts: { lastName: "Lovelace" } }
          : {};
    const graph = createGraph(async () => JSON.stringify({ id: "meeting-1", success: true }), {
      bookingTools: contactTools,
      interpretBookingTurn,
    }).graph;
    const config = { configurable: { thread_id: "compiled-contact-repair" } };
    const draft = readyDraft();
    draft.contactDetails = { phoneNumber: contact.phoneNumber };

    const asked = await graph.invoke({
      messages: [new HumanMessage("Ada")],
      bookingDraft: draft,
      bookingSchemaVersion: 2,
      patientLocale: "en",
      contactContext: { ownership: "telegram", contacts: [{ ...contact }] },
      availabilityContext: { ...bookingIntegrationSnapshot, serviceId: "svc-1" },
    } as never, config);
    expect(asked.pendingInteraction).toMatchObject({ kind: "contact_field", field: "lastName" });
    expect(crmCalls).toEqual([]);

    await graph.invoke({ messages: [new HumanMessage("Lovelace")] } as never, config);
    const checkpoint = await graph.getState(config);
    expect(crmCalls).toEqual(["update_entity", "get_entity"]);
    expect(checkpoint.values.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "contact-1", firstName: "Ada", lastName: "Lovelace" }],
    });
    expect(checkpoint.values.bookingDraft?.pendingEffect?.effect.kind).toBe("create_meeting");
  });

  it("pauses, resumes once on the same checkpoint, consumes the matching effect, and grounds success", async () => {
    const writes: Record<string, unknown>[] = [];
    const { graph } = createGraph(async (args) => {
      writes.push(args);
      return JSON.stringify({ id: "meeting-1", success: true, status: "Planned" });
    });
    const config = { configurable: { thread_id: "compiled-hitl-success" } };

    const paused = await graph.invoke(initialState() as never, config);
    const checkpoint = await graph.getState(config);
    const effectId = checkpoint.values.bookingDraft?.pendingEffect?.id;
    expect(effectId).toBeTruthy();
    expect(checkpoint.next).toContain("booking__tools");
    expect(checkpoint.values.agentMessages).toMatchObject([
      { tool_calls: [{ id: effectId, name: "create_meeting" }] },
    ]);
    expect(writes).toHaveLength(0);

    const resumed = await graph.invoke(new Command({ resume: { confirmed: true } }), config);
    expect(writes).toHaveLength(1);
    expect(resumed.bookingDraft?.pendingEffect).toBeUndefined();
    expect(resumed.bookingDraft?.pendingDecision).toBeUndefined();
    expect(resumed.lastHandoff?.replyText).toContain("Запис створено");
    expect(JSON.stringify(paused)).toContain("confirm_booking");
  });

  it("declines without a write and fails closed when the CRM effect errors", async () => {
    let writes = 0;
    const graph = createGraph(async () => {
      writes += 1;
      return JSON.stringify({ error: "CRM unavailable" });
    }).graph;

    const declineConfig = { configurable: { thread_id: "compiled-hitl-decline" } };
    await graph.invoke(initialState() as never, declineConfig);
    const declined = await graph.invoke(new Command({ resume: { confirmed: false } }), declineConfig);
    expect(writes).toBe(0);
    expect(declined.bookingDraft?.pendingEffect?.status).not.toBe("completed");

    const failureConfig = { configurable: { thread_id: "compiled-hitl-failure" } };
    await graph.invoke(initialState() as never, failureConfig);
    const failed = await graph.invoke(new Command({ resume: { confirmed: true } }), failureConfig);
    expect(writes).toBe(1);
    expect(failed.bookingDraft?.pendingEffect?.status).not.toBe("completed");
    expect(String(failed.messages.at(-1)?.content)).not.toMatch(/created|booked/i);
  });
});

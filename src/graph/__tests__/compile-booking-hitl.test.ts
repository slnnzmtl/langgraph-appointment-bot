import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Command, interrupt, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compileClinicGraph } from "../compile.js";
import { acceptedCreateDraft, bookingIntegrationSnapshot } from "./agent-loop-booking-integration-harness.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";

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

const createGraph = (writeResult: (args: Record<string, unknown>) => Promise<string>) => {
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
  const presentAvailability = tool(async () => JSON.stringify({
    ...bookingIntegrationSnapshot,
    serviceId: "svc-1",
    query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
  }), {
    name: "present_availability_slots",
    description: "Test availability revalidation",
    schema: z.object({}).passthrough(),
  });
  const checkpointer = new MemorySaver();
  return compileClinicGraph({
    specialists: { faq: faqAgent, booking: bookingAgent },
    agentTools: { faq: [], booking: [presentAvailability, createMeeting] },
    agentModel: {
      bindTools: () => ({ invoke: async () => new AIMessage("ok") }),
    } as unknown as BaseChatModel,
    supervisorLlm: {
      bindRoutingTools: () => ({ invoke: async () => ({ next: "booking" }) }),
      withStructuredOutput: () => ({ invoke: async () => ({ text: "Your appointment was processed." }) }),
    } as unknown as ILLMConnector,
    interpretBookingTurn: async () => ({}),
    assignedUserId: "user-1",
    formatSystemMetadata: () => "META",
    messageHistoryMaxTokens: 6_000,
    checkpointer,
  });
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

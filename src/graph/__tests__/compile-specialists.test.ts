import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, it } from "vitest";

import { compileClinicGraph } from "../compile.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";

const bookingAgent: ClinicAgentDefinition = {
  id: "booking",
  name: "Booking",
  description: "Booking",
  systemPrompt: "booking",
  maxSteps: 10,
};

const faqAgent: ClinicAgentDefinition = {
  id: "faq",
  name: "FAQ",
  description: "FAQ",
  systemPrompt: "faq",
  maxSteps: 4,
};

const minimalCompileOptions = {
  agentModel: {
    bindTools: () => ({
      invoke: async () => ({ content: "ok" }),
    }),
  } as unknown as BaseChatModel,
  supervisorLlm: {
    bindRoutingTools: () => ({
      invoke: async () => ({ next: "booking" }),
    }),
  } as ILLMConnector,
  loadSupervisorPrompt: () => "STATIC",
  formatSystemMetadata: () => "META",
  messageHistoryMaxTokens: 6_000,
  agentTools: { faq: [], booking: [] },
};

describe("DDD-264 compileClinicGraph specialists", () => {
  it("requires FAQ and booking specialists", () => {
    expect(() =>
      compileClinicGraph({
        ...minimalCompileOptions,
        agents: [bookingAgent],
      }),
    ).toThrow(/one FAQ and one booking specialist/i);
  });

  it("compiles when both specialists are present", () => {
    const { graph } = compileClinicGraph({
      ...minimalCompileOptions,
      agents: [faqAgent, bookingAgent],
    });
    expect(graph).toBeDefined();
  });
});

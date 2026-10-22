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
  formatSystemMetadata: () => "META",
  messageHistoryMaxTokens: 6_000,
  agentTools: { faq: [], booking: [] },
};

describe("DDD-264 compileClinicGraph specialists", () => {
  it("requires FAQ and booking specialist ids", () => {
    expect(() =>
      compileClinicGraph({
        ...minimalCompileOptions,
        specialists: {
          faq: { ...faqAgent, id: "wrong" as "faq" },
          booking: bookingAgent,
        },
      }),
    ).toThrow(/matching ids/i);
  });

  it("compiles when both specialists are present", () => {
    const { graph } = compileClinicGraph({
      ...minimalCompileOptions,
      specialists: { faq: faqAgent, booking: bookingAgent },
    });
    expect(graph).toBeDefined();
  });
});

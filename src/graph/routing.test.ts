import { describe, expect, it } from "vitest";

import { routeAfterAgentLlm, routeAfterAgentTools } from "./agent-loop.js";
import {
  buildClinicRoutingSchema,
  normalizeDelegationPrompt,
  normalizeSupervisorReply,
} from "./routing.js";
import type { ClinicAgentDefinition } from "./types.js";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const agents: ClinicAgentDefinition[] = [
  {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "faq",
    capabilityIds: ["espocrm-read"],
    maxSteps: 4,
  },
  {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "booking",
    capabilityIds: ["espocrm-booking"],
    maxSteps: 10,
  },
];

describe("clinic routing schema", () => {
  it("accepts faq, booking, and FINISH", () => {
    const schema = buildClinicRoutingSchema(agents);
    expect(schema.parse({ next: "FINISH", reply: "Hello" }).next).toBe("FINISH");
    expect(schema.parse({ next: "faq", prompt: "Hours?" }).next).toBe("faq");
    expect(schema.parse({ next: "booking", prompt: "Book tomorrow" }).next).toBe("booking");
  });

  it("normalizes reply and prompt placeholders", () => {
    expect(normalizeSupervisorReply("  hi  ")).toBe("hi");
    expect(normalizeSupervisorReply("null")).toBeUndefined();
    expect(normalizeDelegationPrompt("  task  ")).toBe("task");
    expect(normalizeDelegationPrompt("   ")).toBeUndefined();
  });
});

describe("agent loop routing", () => {
  it("routes to tools when AI requests tools under maxSteps", () => {
    const state = {
      stepCount: 1,
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "list_services", args: {} }],
        }),
      ],
    };
    expect(routeAfterAgentLlm(state as never, 4, "faq__tools", "faq__finalize")).toBe(
      "faq__tools",
    );
  });

  it("finalizes when maxSteps reached", () => {
    const state = {
      stepCount: 4,
      agentMessages: [new AIMessage("done")],
    };
    expect(routeAfterAgentLlm(state as never, 4, "faq__tools", "faq__finalize")).toBe(
      "faq__finalize",
    );
  });

  it("returns to llm after tools are fulfilled", () => {
    const state = {
      agentMessages: [
        new HumanMessage("hi"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "list_services", args: {} }],
        }),
        new ToolMessage({ content: "{}", tool_call_id: "1" }),
      ],
    };
    expect(routeAfterAgentTools(state as never, "faq__llm", "faq__tools")).toBe("faq__llm");
  });
});

import { describe, expect, it } from "vitest";

import { routeAfterAgentLlm, routeAfterAgentTools } from "../agent-loop.js";
import {
  buildClinicRoutingSchema,
  normalizeSupervisorReply,
} from "../routing.js";
import type { ClinicAgentDefinition } from "../types.js";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const agents: ClinicAgentDefinition[] = [
  {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "booking",
    maxSteps: 10,
  },
];

describe("clinic routing schema", () => {
  it("accepts booking and FINISH", () => {
    const schema = buildClinicRoutingSchema(agents);
    expect(schema.parse({ next: "FINISH", reply: "Hello" }).next).toBe("FINISH");
    expect(schema.parse({ next: "booking" }).next).toBe("booking");
    expect(() => schema.parse({ next: "faq" })).toThrow();
  });

  it("accepts optional FINISH menu", () => {
    const schema = buildClinicRoutingSchema(agents);
    expect(schema.parse({ next: "FINISH", reply: "Hi", menu: "default" }).menu).toBe("default");
    expect(schema.parse({ next: "FINISH", reply: "Visits", menu: "visit_change" }).menu).toBe(
      "visit_change",
    );
  });

  it("normalizes reply placeholders", () => {
    expect(normalizeSupervisorReply("  hi  ")).toBe("hi");
    expect(normalizeSupervisorReply("null")).toBeUndefined();
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
    expect(routeAfterAgentLlm(state as never, 4, "booking__tools", "booking__finalize")).toBe(
      "booking__tools",
    );
  });

  it("finalizes when maxSteps reached", () => {
    const state = {
      stepCount: 4,
      agentMessages: [new AIMessage("done")],
    };
    expect(routeAfterAgentLlm(state as never, 4, "booking__tools", "booking__finalize")).toBe(
      "booking__finalize",
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
    expect(routeAfterAgentTools(state as never, "booking__llm", "booking__tools")).toBe(
      "booking__llm",
    );
  });
});

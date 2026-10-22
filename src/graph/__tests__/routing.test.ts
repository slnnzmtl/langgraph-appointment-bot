import { describe, expect, it } from "vitest";

import {
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
  routeAfterBookingTools,
} from "../agent-loop/index.js";
import {
  buildClinicRoutingSchema,
  normalizeSupervisorReply,
} from "../routing.js";
import type { ClinicSpecialists } from "../types.js";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

const specialists: ClinicSpecialists = {
  faq: {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "faq",
    maxSteps: 4,
  },
  booking: {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "booking",
    maxSteps: 10,
  },
};

describe("clinic routing schema", () => {
  it("accepts faq, booking, and FINISH", () => {
    const schema = buildClinicRoutingSchema(specialists);
    expect(schema.parse({ next: "FINISH", reply: "Hello" }).next).toBe("FINISH");
    expect(schema.parse({ next: "faq" }).next).toBe("faq");
    expect(schema.parse({ next: "booking" }).next).toBe("booking");
  });

  it("accepts optional FINISH menu", () => {
    const schema = buildClinicRoutingSchema(specialists);
    expect(schema.parse({ next: "FINISH", reply: "Hi", menu: "default" }).menu).toBe("default");
    expect(schema.parse({ next: "FINISH", reply: "Visits", menu: "visit_change" }).menu).toBe(
      "visit_change",
    );
  });

  it("accepts optional intent and choiceId", () => {
    const schema = buildClinicRoutingSchema(specialists);
    expect(
      schema.parse({ next: "booking", intent: "visit_cancel" }).intent,
    ).toBe("visit_cancel");
    expect(
      schema.parse({ next: "FINISH", reply: "ok", choiceId: "decline" }).choiceId,
    ).toBe("decline");
  });

  it("normalizes reply placeholders", () => {
    expect(normalizeSupervisorReply("  hi  ")).toBe("hi");
    expect(normalizeSupervisorReply("null")).toBeUndefined();
  });
});

describe("agent loop routing", () => {
  it("routes FAQ prepare chips to finalize and booking handoff to decide", () => {
    expect(
      routeAfterAgentPrepare(
        {
          pendingInteraction: {
            kind: "service_candidate",
            owner: "faq",
            utterance: "catalog",
            choices: [{ id: "svc-only", label: "Only", serviceIds: ["svc-only"] }],
          },
          faqSkipLlm: true,
          messages: [],
        } as never,
        "faq__llm",
        "faq__finalize",
        "booking__decide",
        "faq",
      ),
    ).toBe("faq__finalize");

    expect(
      routeAfterAgentPrepare(
        {
          next: "booking",
          understoodTurn: {
            serviceIntent: { kind: "catalog_service", serviceId: "svc-1" },
          },
          pendingInteraction: null,
          faqSkipLlm: true,
          messages: [],
        } as never,
        "faq__llm",
        "faq__finalize",
        "booking__decide",
        "faq",
      ),
    ).toBe("booking__decide");

    // Idle unique chip without booking handoff must not fall through to llm
    // when faqSkipLlm is set, and must not invent a booking route.
    expect(
      routeAfterAgentPrepare(
        {
          pendingInteraction: {
            kind: "service_candidate",
            owner: "faq",
            utterance: "catalog",
            choices: [{ id: "svc-only", label: "Only", serviceIds: ["svc-only"] }],
          },
          faqSkipLlm: true,
          messages: [],
        } as never,
        "faq__llm",
        "faq__finalize",
        "booking__decide",
        "faq",
      ),
    ).not.toBe("booking__decide");
  });

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
    expect(routeAfterAgentTools(state as never,
        {
          llmName: "faq__llm",
          toolsName: "faq__tools",
        })).toBe("faq__llm");
  });

  it("routes booking tools to decide while an effect is open", () => {
    const names = {
      decideName: "booking__decide",
      toolsName: "booking__tools",
      respondName: "booking__respond",
    };
    const pendingId = "eff_create_1";

    expect(
      routeAfterBookingTools(
        {
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: pendingId, name: "create_meeting", args: {} }],
            }),
            new ToolMessage({
              content: "{}",
              tool_call_id: pendingId,
              name: "create_meeting",
            }),
          ],
          bookingDraft: { pendingEffect: { id: pendingId } },
        } as never,
        names,
      ),
    ).toBe("booking__decide");

    expect(
      routeAfterBookingTools(
        {
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: pendingId, name: "create_meeting", args: {} }],
            }),
          ],
          bookingDraft: { pendingEffect: { id: pendingId } },
        } as never,
        names,
      ),
    ).toBe("booking__tools");

    // Missing ToolMessage still returns to decide (fail-closed), never respond.
    expect(
      routeAfterBookingTools(
        {
          agentMessages: [new AIMessage("confirm on the card")],
          bookingDraft: { pendingEffect: { id: pendingId } },
        } as never,
        names,
      ),
    ).toBe("booking__decide");

    expect(
      routeAfterBookingTools(
        {
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: "other", name: "list_services", args: {} }],
            }),
            new ToolMessage({
              content: "{}",
              tool_call_id: "other",
              name: "list_services",
            }),
          ],
          bookingDraft: { pendingEffect: { id: pendingId } },
        } as never,
        names,
      ),
    ).toBe("booking__decide");

    // Effect cleared → respond.
    expect(
      routeAfterBookingTools(
        {
          agentMessages: [
            new ToolMessage({
              content: "{}",
              tool_call_id: pendingId,
              name: "create_meeting",
            }),
          ],
          bookingDraft: { pendingEffect: null },
        } as never,
        names,
      ),
    ).toBe("booking__respond");
  });
});

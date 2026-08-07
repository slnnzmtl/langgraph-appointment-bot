import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import {
  buildPrefetchedToolMessages,
  createAgentPrepareNode,
  FIND_CONTACT_BY_TELEGRAM_TOOL,
  LIST_SERVICES_TOOL,
} from "./agent-loop.js";
import { hasPendingToolCalls } from "./tool-routing.js";

describe("buildPrefetchedToolMessages", () => {
  it("returns fulfilled AIMessage + ToolMessage pair for a given tool", () => {
    const result = '{"contacts":[{"id":"c-1"}]}';
    const messages = buildPrefetchedToolMessages(FIND_CONTACT_BY_TELEGRAM_TOOL, result);

    expect(messages).toHaveLength(2);
    const [ai, tool] = messages;
    expect(ai).toBeInstanceOf(AIMessage);
    expect(tool).toBeInstanceOf(ToolMessage);

    const aiMessage = ai as AIMessage;
    const toolMessage = tool as ToolMessage;
    expect(aiMessage.tool_calls).toHaveLength(1);
    expect(aiMessage.tool_calls?.[0]?.name).toBe(FIND_CONTACT_BY_TELEGRAM_TOOL);
    expect(aiMessage.tool_calls?.[0]?.args).toEqual({});
    expect(toolMessage.tool_call_id).toBe(aiMessage.tool_calls?.[0]?.id);
    expect(toolMessage.content).toBe(result);
    expect(toolMessage.name).toBe(FIND_CONTACT_BY_TELEGRAM_TOOL);
    expect(hasPendingToolCalls(messages)).toBe(false);
  });

  it("parameterizes tool name for list_services", () => {
    const messages = buildPrefetchedToolMessages(LIST_SERVICES_TOOL, '{"list":[]}');
    const aiMessage = messages[0] as AIMessage;
    const toolMessage = messages[1] as ToolMessage;
    expect(aiMessage.tool_calls?.[0]?.name).toBe(LIST_SERVICES_TOOL);
    expect(toolMessage.name).toBe(LIST_SERVICES_TOOL);
  });

  it("uses unique tool_call_id per call", () => {
    const a = buildPrefetchedToolMessages(FIND_CONTACT_BY_TELEGRAM_TOOL, "{}");
    const b = buildPrefetchedToolMessages(FIND_CONTACT_BY_TELEGRAM_TOOL, "{}");
    const idA = (a[0] as AIMessage).tool_calls?.[0]?.id;
    const idB = (b[0] as AIMessage).tool_calls?.[0]?.id;
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });
});

describe("createAgentPrepareNode with prefetch", () => {
  it("appends prefetched messages after scoped human message", async () => {
    const prepare = createAgentPrepareNode("booking", {
      prefetch: async () => [
        ...buildPrefetchedToolMessages(FIND_CONTACT_BY_TELEGRAM_TOOL, '{"contacts":[]}'),
        ...buildPrefetchedToolMessages(LIST_SERVICES_TOOL, '{"list":[]}'),
      ],
    });

    const update = await prepare({
      messages: [new HumanMessage("Book tomorrow")],
      agentMessages: [],
      stepCount: 5,
      next: "booking",
      delegationPrompt: "Book for tomorrow morning",
      lastHandoff: null,
    });

    expect(update.stepCount).toBe(0);
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Book for tomorrow morning");
    expect(agentMessages[1]).toBeInstanceOf(AIMessage);
    expect(agentMessages[2]).toBeInstanceOf(ToolMessage);
    expect((agentMessages[2] as ToolMessage).name).toBe(FIND_CONTACT_BY_TELEGRAM_TOOL);
    expect(agentMessages[3]).toBeInstanceOf(AIMessage);
    expect(agentMessages[4]).toBeInstanceOf(ToolMessage);
    expect((agentMessages[4] as ToolMessage).name).toBe(LIST_SERVICES_TOOL);
    expect(hasPendingToolCalls(agentMessages as never)).toBe(false);
  });

  it("injects error ToolMessage when prefetch returns error JSON", async () => {
    const prepare = createAgentPrepareNode("booking", {
      prefetch: async () =>
        buildPrefetchedToolMessages(
          FIND_CONTACT_BY_TELEGRAM_TOOL,
          JSON.stringify({ error: "CRM down" }),
        ),
    });

    const update = await prepare({
      messages: [new HumanMessage("Book")],
      agentMessages: [],
      stepCount: 0,
      next: "booking",
      delegationPrompt: null,
      lastHandoff: null,
    });

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    const tool = agentMessages[agentMessages.length - 1] as ToolMessage;
    expect(tool).toBeInstanceOf(ToolMessage);
    expect(JSON.parse(String(tool.content))).toEqual({ error: "CRM down" });
  });

  it("skips prefetch when option omitted", async () => {
    const prepare = createAgentPrepareNode("faq");
    const update = await prepare({
      messages: [new HumanMessage("Hours?")],
      agentMessages: [],
      stepCount: 0,
      next: "faq",
      delegationPrompt: "What are hours?",
      lastHandoff: null,
    });

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
  });
});

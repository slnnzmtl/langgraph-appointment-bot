import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildPrefetchedToolMessages,
  createAgentPrepareNode,
  FIND_CONTACT_BY_TELEGRAM_TOOL,
  LIST_SERVICES_TOOL,
} from "../agent-loop.js";
import { hasPendingToolCalls } from "../tool-routing.js";
import type { ClinicAgentDefinition } from "../types.js";

const createCachedGeminiModel = vi.fn(
  (_apiKey: string, _model: string, handle: { cacheName: string }) => ({
    kind: "cached",
    cacheName: handle.cacheName,
    bindTools: vi.fn(),
  }),
);

const isCachedContentNotFoundError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /CachedContent not found/i.test(message);
});

vi.mock("@personal-assistant/llm-gemini", () => ({
  createCachedGeminiModel: (...args: unknown[]) =>
    (createCachedGeminiModel as (...a: unknown[]) => unknown)(...args),
  isCachedContentNotFoundError: (error: unknown) => isCachedContentNotFoundError(error),
}));

const { createAgentLlmNode } = await import("../agent-loop.js");

describe("buildPrefetchedToolMessages", () => {
  it("returns fulfilled AIMessage + ToolMessage pair for a given tool", () => {
    const result = '{"contacts":[{"id":"c-1"}]}';
    const messages = buildPrefetchedToolMessages(FIND_CONTACT_BY_TELEGRAM_TOOL, result);

    expect(messages).toHaveLength(2);
    const [ai, toolMsg] = messages;
    expect(ai).toBeInstanceOf(AIMessage);
    expect(toolMsg).toBeInstanceOf(ToolMessage);

    const aiMessage = ai as AIMessage;
    const toolMessage = toolMsg as ToolMessage;
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
  it("keeps original human message and appends prefetched tools", async () => {
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
      lastHandoff: null,
    });

    expect(update.stepCount).toBe(0);
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Book tomorrow");
    expect(agentMessages[1]).toBeInstanceOf(AIMessage);
    expect(agentMessages[2]).toBeInstanceOf(ToolMessage);
    expect((agentMessages[2] as ToolMessage).name).toBe(FIND_CONTACT_BY_TELEGRAM_TOOL);
    expect(agentMessages[3]).toBeInstanceOf(AIMessage);
    expect(agentMessages[4]).toBeInstanceOf(ToolMessage);
    expect((agentMessages[4] as ToolMessage).name).toBe(LIST_SERVICES_TOOL);
    expect(hasPendingToolCalls(agentMessages as never)).toBe(false);
  });

  it("passes full thread history including other agents' replies", async () => {
    const prepare = createAgentPrepareNode("booking");
    const faqReply = new AIMessage({
      content: "hours are 9-18",
      additional_kwargs: { runtimeAgentId: "faq" },
    });
    const bookingReply = new AIMessage({
      content: "what day?",
      additional_kwargs: { runtimeAgentId: "booking" },
    });

    const update = await prepare({
      messages: [
        new HumanMessage("hours?"),
        faqReply,
        new HumanMessage("book tomorrow"),
        bookingReply,
        new HumanMessage("10:00"),
      ],
      agentMessages: [],
      stepCount: 0,
      next: "booking",
      lastHandoff: null,
    });

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages.map((m) => m.getType())).toEqual([
      "human",
      "ai",
      "human",
      "ai",
      "human",
    ]);
    expect((agentMessages[0] as HumanMessage).content).toBe("hours?");
    expect((agentMessages[4] as HumanMessage).content).toBe("10:00");
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
      lastHandoff: null,
    });

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    const toolMsg = agentMessages[agentMessages.length - 1] as ToolMessage;
    expect(toolMsg).toBeInstanceOf(ToolMessage);
    expect(JSON.parse(String(toolMsg.content))).toEqual({ error: "CRM down" });
  });

  it("skips prefetch when option omitted", async () => {
    const prepare = createAgentPrepareNode("faq");
    const update = await prepare({
      messages: [new HumanMessage("Hours?")],
      agentMessages: [],
      stepCount: 0,
      next: "faq",
      lastHandoff: null,
    });

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Hours?");
  });
});

describe("createAgentLlmNode context cache", () => {
  const sampleTool = tool(async () => "ok", {
    name: "list_services",
    description: "List services",
    schema: z.object({}),
  });

  const faqAgent: ClinicAgentDefinition = {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "STATIC FAQ PROMPT",
    maxSteps: 4,
  };

  const invoke = vi.fn();
  const bindTools = vi.fn(() => ({ invoke }));
  const cachedInvoke = vi.fn();

  const model = { bindTools } as unknown as BaseChatModel;

  beforeEach(() => {
    invoke.mockReset();
    bindTools.mockClear();
    cachedInvoke.mockReset();
    createCachedGeminiModel.mockReset();
    isCachedContentNotFoundError.mockClear();
    createCachedGeminiModel.mockImplementation(
      (_apiKey: string, _model: string, handle: { cacheName: string }) => ({
        kind: "cached",
        cacheName: handle.cacheName,
        bindTools: vi.fn(),
        invoke: cachedInvoke,
      }),
    );
    invoke.mockResolvedValue(new AIMessage("uncached reply"));
    cachedInvoke.mockResolvedValue(new AIMessage("cached reply"));
  });

  it("uses SystemMessage with static prompt when cache misses", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => null),
      invalidate: vi.fn(),
    };

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC METADATA",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node({
      messages: [],
      agentMessages: [new HumanMessage("hours?")],
      stepCount: 0,
      next: "faq",
      lastHandoff: null,
    });

    expect(createCachedGeminiModel).not.toHaveBeenCalled();
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "gemini-2.5-flash",
        staticSystemInstruction: "STATIC FAQ PROMPT",
        tools: [sampleTool],
        displayName: "clinic-faq",
      }),
    );
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC FAQ PROMPT");
    expect((messages[0] as SystemMessage).content).toContain("DYNAMIC METADATA");
    const agentMessages = update.agentMessages as AIMessage[];
    expect(agentMessages[0]).toBeInstanceOf(AIMessage);
    expect(agentMessages[0].content).toBe("uncached reply");
  });

  it("uses HumanMessage for dynamic context on cache hit (not SystemMessage)", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await node({
      messages: [],
      agentMessages: [new HumanMessage("hours?")],
      stepCount: 0,
      next: "faq",
      lastHandoff: null,
    });

    expect(createCachedGeminiModel).toHaveBeenCalledOnce();
    expect(bindTools).toHaveBeenCalledTimes(1);
    const messages = cachedInvoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect((messages[0] as HumanMessage).content).toBe("DYNAMIC KYIV");
    expect(messages.some((m) => m instanceof SystemMessage)).toBe(false);
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "clinic-faq",
        tools: [sampleTool],
      }),
    );
  });

  it("invalidates and retries once on CachedContent not found", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash",
        })
        .mockResolvedValueOnce({
          cacheName: "caches/fresh",
          model: "models/gemini-2.5-flash",
        }),
      invalidate: vi.fn(),
    };

    cachedInvoke
      .mockRejectedValueOnce(new Error("CachedContent not found"))
      .mockResolvedValueOnce(new AIMessage("recovered"));

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node({
      messages: [],
      agentMessages: [new HumanMessage("hours?")],
      stepCount: 0,
      next: "faq",
      lastHandoff: null,
    });

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect((update.agentMessages as AIMessage[])[0].content).toBe("recovered");
  });

  it("falls back to uncached when recreate returns null", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash",
        })
        .mockResolvedValueOnce(null),
      invalidate: vi.fn(),
    };

    cachedInvoke.mockRejectedValueOnce(new Error("CachedContent not found"));
    invoke.mockResolvedValueOnce(new AIMessage("uncached after miss"));

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node({
      messages: [],
      agentMessages: [new HumanMessage("hours?")],
      stepCount: 0,
      next: "faq",
      lastHandoff: null,
    });

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(createCachedGeminiModel).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC FAQ PROMPT");
    expect((messages[0] as SystemMessage).content).toContain("DYN");
    expect((update.agentMessages as AIMessage[])[0].content).toBe("uncached after miss");
  });

  it("uses clinic-booking displayName for booking agent", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => null),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const node = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await node({
      messages: [],
      agentMessages: [new HumanMessage("book")],
      stepCount: 0,
      next: "booking",
      lastHandoff: null,
    });

    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "clinic-booking" }),
    );
  });
});

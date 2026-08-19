import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentPrepareNode, crmWriteDirtiesPrefetch } from "../agent-loop.js";
import {
  formatContactContext,
  formatListedMeetingsContext,
} from "../context-blocks.js";
import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import type { ClinicState } from "../state.js";
import type { ClinicAgentDefinition } from "../types.js";

const listedMeetings: BookingContext = {
  meetings: [
    {
      id: "m-1",
      name: "Консультація: Daniel",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    },
  ],
  dateFrom: "2026-08-11",
};

const listedContact: ContactLookupContext = {
  contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] }],
};

const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  ...overrides,
});

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

describe("formatListedMeetingsContext", () => {
  it("returns an empty string when context is missing", () => {
    expect(formatListedMeetingsContext(null)).toBe("");
  });

  it("renders an empty meetings list so the model does not re-fetch", () => {
    const block = formatListedMeetingsContext({ meetings: [], dateFrom: "2026-08-11" });
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain('"meetings":[]');
  });

  it("wraps the list payload for uncached system metadata", () => {
    const block = formatListedMeetingsContext(listedMeetings);
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain("</list_planned_meetings>");
    expect(block).toContain(JSON.stringify(listedMeetings));
  });
});

describe("formatContactContext", () => {
  it("returns an empty string when context is missing", () => {
    expect(formatContactContext(null)).toBe("");
  });

  it("renders an empty contacts list so the model does not re-fetch", () => {
    const block = formatContactContext({ contacts: [] });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"contacts":[]');
  });

  it("renders error lookups as a completed prefetch block", () => {
    const block = formatContactContext({ contacts: [], error: "CRM down" });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"error":"CRM down"');
  });

  it("wraps the contact payload for uncached system metadata", () => {
    const block = formatContactContext(listedContact);
    expect(block).toContain("<contact_info>");
    expect(block).toContain("</contact_info>");
    expect(block).toContain(JSON.stringify(listedContact));
  });
});

describe("createAgentPrepareNode", () => {
  it("keeps original human message without synthetic ToolMessages or CRM writes", async () => {
    const prepare = createAgentPrepareNode("booking");

    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Book tomorrow")],
        stepCount: 5,
        next: "booking",
        contactContext: listedContact,
        bookingContext: listedMeetings,
      }),
    );

    expect(update.stepCount).toBe(0);
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Book tomorrow");
    expect(agentMessages.some((m) => m instanceof ToolMessage)).toBe(false);
    expect(update.contactContext).toBeUndefined();
    expect(update.bookingContext).toBeUndefined();
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

    const update = await prepare(
      clinicState({
        messages: [
          new HumanMessage("hours?"),
          faqReply,
          new HumanMessage("book tomorrow"),
          bookingReply,
          new HumanMessage("10:00"),
        ],
        next: "booking",
      }),
    );

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
});

describe("crmWriteDirtiesPrefetch", () => {
  it("is true for a successful CRM write tool result", () => {
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ id: "c-1" }),
          tool_call_id: "1",
          name: "create_contact",
        }),
      ]),
    ).toBe(true);
  });

  it("is false for HITL pending, errors, and read tools", () => {
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ cancelled: true }),
          tool_call_id: "1",
          name: "cancel_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          tool_call_id: "1",
          name: "update_contact",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ slots: [] }),
          tool_call_id: "1",
          name: "present_availability_slots",
        }),
      ]),
    ).toBe(false);
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

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

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

    await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

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

  it("appends contact and listed meetings to booking dynamic context only", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const faqNode = createAgentLlmNode({
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
    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await faqNode(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        bookingContext: listedMeetings,
        contactContext: listedContact,
        next: "faq",
      }),
    );
    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("скасуй")],
        bookingContext: listedMeetings,
        contactContext: listedContact,
        next: "booking",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    const bookingDynamic = (cachedInvoke.mock.calls[1]?.[0] as unknown[])[0] as HumanMessage;
    expect(faqDynamic.content).toBe("DYNAMIC KYIV");
    expect(String(faqDynamic.content)).not.toContain("<list_planned_meetings>");
    expect(String(faqDynamic.content)).not.toContain("<contact_info>");
    expect(bookingDynamic.content).toContain("DYNAMIC KYIV");
    expect(bookingDynamic.content).toContain(formatContactContext(listedContact));
    expect(bookingDynamic.content).toContain(formatListedMeetingsContext(listedMeetings));
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

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

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

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

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

    await node(
      clinicState({
        agentMessages: [new HumanMessage("book")],
        next: "booking",
      }),
    );

    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "clinic-booking" }),
    );
  });
});

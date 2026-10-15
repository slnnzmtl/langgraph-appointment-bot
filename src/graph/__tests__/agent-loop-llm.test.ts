import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  formatBookingMeetingsContext,
  formatContactContext,
  formatPlannedVisitsFlag,
} from "../context-blocks.js";
import { type ClinicAgentDefinition } from "../types.js";

import {
  clinicState,
  makeListedContact,
  makeListedMeetings,
} from "./agent-loop-fixtures.js";



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

const { createAgentLlmNode } = await import("../agent-loop/index.js");



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
    expect((messages[0] as HumanMessage).content).toBe(
      'DYNAMIC KYIV\n\n<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
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
        bookingContext: makeListedMeetings(),
        contactContext: makeListedContact(),
        next: "faq",
      }),
    );
    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("скасуй")],
        bookingContext: makeListedMeetings(),
        contactContext: makeListedContact(),
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    const bookingDynamic = (cachedInvoke.mock.calls[1]?.[0] as unknown[])[0] as HumanMessage;
    expect(faqDynamic.content).toContain("DYNAMIC KYIV");
    expect(String(faqDynamic.content)).toContain(formatPlannedVisitsFlag(makeListedMeetings()));
    expect(String(faqDynamic.content)).not.toContain("<contact_info>");
    expect(String(faqDynamic.content)).not.toContain('"visitLabel"');
    expect(String(faqDynamic.content)).not.toContain('"meetings"');
    expect(String(faqDynamic.content)).not.toContain("<availability>");
    expect(String(faqDynamic.content)).not.toContain("<list_services>");
    expect(bookingDynamic.content).toContain("DYNAMIC KYIV");
    expect(bookingDynamic.content).toContain(formatContactContext(makeListedContact()));
    expect(bookingDynamic.content).toContain(formatBookingMeetingsContext(makeListedMeetings()));
    // Full days[] is not injected into the LLM prompt (served via slots tool / cache).
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
    expect(String(bookingDynamic.content)).not.toContain('"visits"');
  });

  it("appends list_services to FAQ and booking when catalog is set and availability is empty", async () => {
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

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
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
        agentMessages: [new HumanMessage("Послуги")],
        servicesContext: sampleServices,
        next: "faq",
      }),
    );
    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("Записатись")],
        servicesContext: sampleServices,
        next: "booking",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    const bookingDynamic = (cachedInvoke.mock.calls[1]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).toContain("<list_services>");
    expect(String(faqDynamic.content)).toContain("svc-1");
    expect(String(bookingDynamic.content)).toContain("<list_services>");
    expect(String(bookingDynamic.content)).toContain("svc-1");
  });

  it("keeps list_services on booking when availabilityContext has days", async () => {
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

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    };

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

    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("4 вересня")],
        servicesContext: sampleServices,
        availabilityContext: {
          days: [{ date: "2026-09-04", slots: [{ label: "11:00", dateStart: "2026-09-04T11:00:00", dateEnd: "2026-09-04T11:30:00" }] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).toContain("<list_services>");
  });

  it("still appends list_services to FAQ when availabilityContext is set", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
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

    await faqNode(
      clinicState({
        agentMessages: [new HumanMessage("Послуги")],
        servicesContext: sampleServices,
        availabilityContext: {
          days: [{ date: "2026-09-04", slots: [] }],
          stepMinutes: 30,
        },
        next: "faq",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).toContain("<list_services>");
  });

  it("omits list_services block when list_services already ran this turn", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
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

    await faqNode(
      clinicState({
        agentMessages: [
          new HumanMessage("Послуги"),
          new ToolMessage({
            content: JSON.stringify({ list: [{ id: "svc-1", name: "Консультація" }] }),
            tool_call_id: "1",
            name: "list_services",
          }),
        ],
        stepCount: 1,
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
        next: "faq",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).not.toContain("<list_services>");
  });

  it("omits full availability from booking LLM even when a different tool ran this turn", async () => {
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

    await bookingNode(
      clinicState({
        agentMessages: [
          new HumanMessage("Записатись"),
          new ToolMessage({
            content: JSON.stringify({ list: [{ id: "svc-1", name: "Консультація" }] }),
            tool_call_id: "1",
            name: "list_services",
          }),
        ],
        stepCount: 1,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
  });

  it("omits availability block when present_availability_slots already ran this turn", async () => {
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

    await bookingNode(
      clinicState({
        agentMessages: [
          new HumanMessage("book"),
          new ToolMessage({
            content: JSON.stringify({ days: [] }),
            tool_call_id: "1",
            name: "present_availability_slots",
          }),
        ],
        stepCount: 1,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
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



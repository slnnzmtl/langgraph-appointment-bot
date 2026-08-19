import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClinicState } from "../state.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";

const createCachedGeminiModel = vi.fn((_apiKey: string, _model: string, handle: { cacheName: string }) => ({
  kind: "cached",
  cacheName: handle.cacheName,
}));

const isCachedContentNotFoundError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /CachedContent not found/i.test(message);
});

vi.mock("@personal-assistant/llm-gemini", () => ({
  createCachedGeminiModel: (...args: unknown[]) =>
    (createCachedGeminiModel as (...a: unknown[]) => unknown)(...args),
  isCachedContentNotFoundError: (error: unknown) => isCachedContentNotFoundError(error),
}));

const { createClinicSupervisorNode, isPrefetchExpired, PREFETCH_TTL_MS } =
  await import("../supervisor.js");

const supervisorState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
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

const agents: ClinicAgentDefinition[] = [
  {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "faq",
    maxSteps: 4,
  },
  {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "booking",
    maxSteps: 10,
  },
];

describe("createClinicSupervisorNode context cache", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    createCachedGeminiModel.mockClear();
    isCachedContentNotFoundError.mockClear();
    invoke.mockResolvedValue({ next: "FINISH", reply: "Hi there" });
  });

  it("uses SystemMessage with full static prompt when cache misses", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => null),
      invalidate: vi.fn(),
    };

    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC PROMPT",
      buildSupervisorDynamicContext: () => "DYNAMIC",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash-lite",
      },
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("hello")] }),
    );

    expect(update.next).toBe("FINISH");
    expect(createCachedGeminiModel).not.toHaveBeenCalled();
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC PROMPT");
    expect((messages[0] as SystemMessage).content).toContain("DYNAMIC");
  });

  it("uses HumanMessage for dynamic context on cache hit (not SystemMessage)", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash-lite",
      })),
      invalidate: vi.fn(),
    };

    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC PROMPT",
      buildSupervisorDynamicContext: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash-lite",
      },
    });

    await node(
      supervisorState({ messages: [new HumanMessage("hello")] }),
    );

    expect(createCachedGeminiModel).toHaveBeenCalledOnce();
    expect(bindRoutingTools.mock.calls[0]?.[1]).toMatchObject({
      model: { kind: "cached", cacheName: "caches/abc" },
    });
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect((messages[0] as HumanMessage).content).toBe("DYNAMIC KYIV");
    expect(messages.some((m) => m instanceof SystemMessage)).toBe(false);
  });

  it("invalidates and retries once on CachedContent not found", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash-lite",
        })
        .mockResolvedValueOnce({
          cacheName: "caches/fresh",
          model: "models/gemini-2.5-flash-lite",
        }),
      invalidate: vi.fn(),
    };

    invoke
      .mockRejectedValueOnce(new Error("CachedContent not found"))
      .mockResolvedValueOnce({ next: "faq" });

    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      buildSupervisorDynamicContext: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash-lite",
      },
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("hours?")] }),
    );

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(update).toMatchObject({ next: "faq", lastHandoff: null });
  });

  it("falls back to uncached when recreate returns null", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash-lite",
        })
        .mockResolvedValueOnce(null),
      invalidate: vi.fn(),
    };

    invoke
      .mockRejectedValueOnce(new Error("CachedContent not found"))
      .mockResolvedValueOnce({ next: "FINISH", reply: "Uncached reply" });

    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      buildSupervisorDynamicContext: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash-lite",
      },
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("hours?")] }),
    );

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(createCachedGeminiModel).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[1]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC");
    expect((messages[0] as SystemMessage).content).toContain("DYN");
    expect(update.next).toBe("FINISH");
    expect(update.messages?.[0]).toBeInstanceOf(AIMessage);
    expect((update.messages?.[0] as AIMessage).content).toBe("Uncached reply");
  });

  it("routes to booking without rewriting a specialist prompt", async () => {
    invoke.mockResolvedValue({ next: "booking", reply: "ignored when delegating" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("book")] }),
    );

    expect(update).toEqual({
      next: "booking",
      lastHandoff: null,
    });
    expect(update.messages).toBeUndefined();
  });
});

describe("createClinicSupervisorNode patient prefetch", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  const listedContact = {
    contacts: [{ id: "c-1", firstName: "Марія" }],
  };
  const listedMeetings = {
    meetings: [
      {
        id: "m-1",
        name: "Консультація - Марія",
        dateStart: "2026-08-12 10:00:00",
        dateEnd: "2026-08-12 10:30:00",
      },
    ],
    dateFrom: "2026-08-11",
  };

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт, Марія" });
  });

  it("injects contact and planned meetings into dynamic context and state", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      buildSupervisorDynamicContext: () => "DYNAMIC",
      prefetch: async () => ({
        contactContext: listedContact,
        bookingContext: listedMeetings,
      }),
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("привіт")] }),
    );

    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    const system = String((messages[0] as SystemMessage).content);
    expect(system).toContain("DYNAMIC");
    expect(system).toContain("<contact_info>");
    expect(system).toContain("Марія");
    expect(system).toContain("<list_planned_meetings>");
    expect(system).toContain("Консультація - Марія");
    expect(update.contactContext).toEqual(listedContact);
    expect(update.bookingContext).toEqual(listedMeetings);
    expect(update.prefetchDirty).toBe(false);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("reuses checkpointed prefetch when fresh and not dirty", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: listedMeetings,
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      buildSupervisorDynamicContext: () => "DYNAMIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("привіт")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).not.toHaveBeenCalled();
    expect(update.contactContext).toBeUndefined();
    expect(update.bookingContext).toBeUndefined();
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    const system = String((messages[0] as SystemMessage).content);
    expect(system).toContain("Марія");
    expect(system).toContain("<list_planned_meetings>");
  });

  it("refetches when prefetchFetchedAt is missing", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: listedMeetings,
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("привіт")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.contactContext).toEqual(listedContact);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("refetches when prefetch age exceeds TTL", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: listedMeetings,
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
      prefetchTtlMs: 1_000,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("привіт")],
        contactContext: { contacts: [{ id: "stale" }] },
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now() - 1_000,
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.contactContext).toEqual(listedContact);
    expect(update.prefetchDirty).toBe(false);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("refetches when prefetchDirty is set even if still within TTL", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: listedMeetings,
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("привіт")],
        contactContext: { contacts: [{ id: "stale" }] },
        bookingContext: null,
        prefetchDirty: true,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.contactContext).toEqual(listedContact);
    expect(update.bookingContext).toEqual(listedMeetings);
    expect(update.prefetchDirty).toBe(false);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("still greets when prefetch throws", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      buildSupervisorDynamicContext: () => "DYNAMIC",
      prefetch: async () => {
        throw new Error("CRM down");
      },
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("hello")] }),
    );

    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    const system = String((messages[0] as SystemMessage).content);
    expect(system).toContain("DYNAMIC");
    expect(system).not.toContain("<contact_info>");
    expect(system).not.toContain("<list_planned_meetings>");
    expect(update.next).toBe("FINISH");
    expect(update.contactContext).toBeUndefined();
  });
});

describe("isPrefetchExpired", () => {
  it("treats a missing timestamp as expired", () => {
    expect(isPrefetchExpired(null, PREFETCH_TTL_MS)).toBe(true);
    expect(isPrefetchExpired(undefined, PREFETCH_TTL_MS)).toBe(true);
  });

  it("expires at the TTL boundary", () => {
    const now = 10_000;
    expect(isPrefetchExpired(now - PREFETCH_TTL_MS + 1, PREFETCH_TTL_MS, now)).toBe(false);
    expect(isPrefetchExpired(now - PREFETCH_TTL_MS, PREFETCH_TTL_MS, now)).toBe(true);
  });
});

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  VISIT_CHANGE_MENU,
} from "../../shared/clinic-constants.js";
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

const { createClinicSupervisorNode, isPrefetchExpired, PREFETCH_TTL_MS, shouldContinueInBooking, shouldContinueInFaq, stickyContinueAgentId } =
  await import("../supervisor.js");

const supervisorState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
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
    expect((messages[0] as HumanMessage).content).toContain("DYNAMIC KYIV");
    expect((messages[0] as HumanMessage).content).toContain('"visits":"none"');
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

  it("strips reply_buttons from FINISH history and attaches code-owned DEFAULT MENU", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply:
        "Привіт, Тест!\n\n<reply_buttons>\nЗаписатись\nПослуги\nАдреса\n</reply_buttons>",
      menu: "default",
    });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(String(update.messages?.[0]?.content)).toBe("Привіт, Тест!");
    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "ok",
      replyText: "Привіт, Тест!",
      replyButtons: ["Записатись", "Послуги", "Адреса"],
    });
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
    expect(system).toContain('"visits":"has"');
    expect(system).not.toContain("visitLabels");
    expect(system).not.toContain('"id":"m-1"');
    expect(update.contactContext).toEqual(listedContact);
    expect(update.bookingContext).toEqual(listedMeetings);
    expect(update.prefetchDirty).toBe(false);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
    expect(update.availabilityContext).toBeNull();
    expect(update.servicesContext).toBeUndefined();
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

  it("clears availabilityContext but keeps servicesContext when prefetch refetches", async () => {
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
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
          total: 1,
        },
        prefetchFetchedAt: Date.now() - 1_000,
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
    expect(update.servicesContext).toBeUndefined();
  });

  it("keeps note ladder across TTL when patient taps INTENT skip", async () => {
    const slot = {
      dateStart: "2026-09-29T11:00:00",
      dateEnd: "2026-09-29T11:30:00",
      label: "11:00",
    };
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
        messages: [new HumanMessage(INTENT_SKIP_LABEL)],
        contactContext: { contacts: [{ id: "stale" }] },
        bookingContext: listedMeetings,
        availabilityContext: {
          days: [{ date: "2026-09-29", slots: [] }],
          stepMinutes: 30,
        },
        bookingNoteStatus: "awaiting",
        selectedSlot: slot,
        prefetchFetchedAt: Date.now() - 1_000,
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Чи можете поділитися деталями перед записом?",
          replyButtons: [INTENT_SKIP_LABEL],
        },
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.next).toBe("booking");
  });

  it("refetches on Мій запис even when prefetch is fresh", async () => {
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
        messages: [new HumanMessage("Мій запис")],
        contactContext: { contacts: [{ id: "stale" }] },
        bookingContext: null,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.contactContext).toEqual(listedContact);
    expect(update.bookingContext).toEqual(listedMeetings);
    expect(update.prefetchDirty).toBe(false);
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("refetches on Мій запис when it is the last of consecutive human messages", async () => {
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

    await node(
      supervisorState({
        messages: [new HumanMessage("привіт"), new HumanMessage("Мій запис")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
  });

  it("refetches on My visit even when prefetch is fresh", async () => {
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

    await node(
      supervisorState({
        messages: [new HumanMessage("My visit")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
  });

  it("refetches on Головне меню even when prefetch is fresh", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: { meetings: [], dateFrom: "2026-08-11" },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Головне меню")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.bookingContext?.meetings).toEqual([]);
  });

  it("refetches on Скасувати even when prefetch is fresh", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: { meetings: [], dateFrom: "2026-08-11" },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Скасувати")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
        lastHandoff: {
          agentId: "supervisor",
          agentName: "supervisor",
          status: "ok",
          replyText: "visit list",
          replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
        },
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.bookingContext?.meetings).toEqual([]);
    expect(update.next).toBe("booking");
  });

  it("keeps selectedSlot and note on Скасувати when a slot is already chosen (REPLACE)", async () => {
    const slot = {
      dateStart: "2026-09-29T12:00:00",
      dateEnd: "2026-09-29T13:00:00",
      label: "12:00",
    };
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
        messages: [new HumanMessage("Скасувати")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
        bookingNoteStatus: "skipped",
        selectedSlot: slot,
        availabilityContext: {
          days: [{ date: "2026-09-29", slots: [] }],
          stepMinutes: 60,
        },
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Already booked",
          replyButtons: ["Скасувати", "Ні, дякую"],
        },
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.availabilityContext).toBeNull();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.next).toBe("booking");
  });

  it("wipes selectedSlot and note on Скасувати when no slot is chosen (visit-change)", async () => {
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
        messages: [new HumanMessage("Скасувати")],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        prefetchFetchedAt: Date.now(),
        bookingNoteStatus: "answered",
        selectedSlot: null,
        availabilityContext: {
          days: [{ date: "2026-09-29", slots: [] }],
          stepMinutes: 60,
        },
        lastHandoff: {
          agentId: "FINISH",
          agentName: "supervisor",
          status: "ok",
          replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
        },
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
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
    expect(system).toContain('"visits":"none"');
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

describe("shouldContinueInBooking", () => {
  it("is true when last handoff is booking/ok and the human taps an offered label", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["25 серпня", "3 вересня", "Інша дата"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("25 серпня"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is true when reply buttons were stripped from checkpointed history", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("Так"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is false for supervisor-owned labels even when they appear on lastHandoff", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("Обрати іншу процедуру"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Мій запис", "Послуги", "Адреса"],
          },
          messages: [
            new AIMessage("Чим можу допомогти?"),
            new HumanMessage("Послуги"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for free text and for non-booking handoffs", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["25 серпня"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("а скільки коштує?"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["25 серпня"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("25 серпня"),
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldContinueInFaq", () => {
  it("is true when last handoff is faq/ok and the human taps an offered catalog label", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["Ін'єкційні процедури", "Консультації та діагностика"],
          },
          messages: [
            new AIMessage("Який напрямок вас цікавить?"),
            new HumanMessage("Ін'єкційні процедури"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is true when reply buttons were stripped from checkpointed history", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["ботулінотерапія", "збільшення губ"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("ботулінотерапія"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is false when lastHandoff yielded to supervisor", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            yieldToSupervisor: true,
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Записати вас на консультацію?"),
            new HumanMessage("Так"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for supervisor-owned labels, free text, and non-faq handoffs", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["Записатись", "Послуги", "Адреса"],
          },
          messages: [
            new AIMessage("Чим можу допомогти?"),
            new HumanMessage("Послуги"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["ботулінотерапія"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("а скільки коштує?"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["ботулінотерапія"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("ботулінотерапія"),
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("createClinicSupervisorNode sticky faq continue", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "booking", reply: "should not be used" });
  });

  it("skips the LLM and routes to faq when a catalog shortcut is tapped", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          replyButtons: ["Ін'єкційні процедури"],
        },
        messages: [
          new AIMessage("Який напрямок вас цікавить?"),
          new HumanMessage("Ін'єкційні процедури"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(update).toMatchObject({ next: "faq", lastHandoff: null });
  });

  it("still calls the LLM after a yielded FAQ consultation offer", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          yieldToSupervisor: true,
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage("Записати вас на консультацію?"),
          new HumanMessage("Так"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
  });
});

describe("createClinicSupervisorNode sticky booking continue", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "faq", reply: "should not be used" });
  });

  it("skips the LLM and routes to booking when a booking shortcut is tapped", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      bookingContext: { meetings: [], dateFrom: "2026-08-11" },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["25 серпня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage("25 серпня"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledOnce();
    expect(update).toMatchObject({
      next: "booking",
      lastHandoff: null,
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      prefetchDirty: false,
    });
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("still calls the LLM for free text after a booking turn", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["25 серпня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage("а скільки коштує консультація?"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("faq");
  });
});

describe("stickyContinueAgentId visit-change after FINISH", () => {
  it("routes Скасувати and Перенести to booking without needing stored buttons", () => {
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: {
            agentId: "FINISH",
            agentName: "supervisor",
            status: "ok",
            replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
          },
          messages: [
            new AIMessage("Бажаєте перенести або скасувати цей візит?"),
            new HumanMessage("Скасувати"),
          ],
        }),
      ),
    ).toBe("booking");
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: null,
          messages: [
            new AIMessage("Заплановані візити: консультація — 21 серпня о 11:00 🗓️"),
            new HumanMessage("Перенести"),
          ],
        }),
      ),
    ).toBe("booking");
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: null,
          messages: [new HumanMessage("Cancel")],
        }),
      ),
    ).toBe("booking");
  });

  it("does not sticky-route Ні, дякую (supervisor-owned)", () => {
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: {
            agentId: "FINISH",
            agentName: "supervisor",
            status: "ok",
            replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
          },
          messages: [new HumanMessage("Ні, дякую")],
        }),
      ),
    ).toBeNull();
  });
});

describe("createClinicSupervisorNode visit-change sticky", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "faq", reply: "should not be used" });
  });

  it("skips the LLM and routes Скасувати to booking after a FINISH visit list", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      bookingContext: {
        meetings: [
          {
            id: "m-1",
            name: "Консультація - Ada",
            dateStart: "2026-08-21 11:00:00",
            dateEnd: "2026-08-21 11:30:00",
          },
        ],
        dateFrom: "2026-08-11",
      },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "FINISH",
          agentName: "supervisor",
          status: "ok",
        },
        messages: [
          new AIMessage("Заплановані візити: консультація — 21 серпня о 11:00 🗓️"),
          new HumanMessage("Скасувати"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledOnce();
    expect(update).toMatchObject({
      next: "booking",
      lastHandoff: null,
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
    });
  });
});

describe("createClinicSupervisorNode code-owned FINISH menus", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  const meetings = {
    meetings: [
      {
        id: "m-1",
        name: "Консультація - Ada",
        dateStart: "2026-08-21 11:00:00",
        dateEnd: "2026-08-21 11:30:00",
      },
    ],
    dateFrom: "2026-08-11",
  };

  const visitAsk =
    "Заплановані візити:\n🗓️ Консультація - 21 серпня (п'ятниця) о 11:00\n\nБажаєте перенести або скасувати цей візит?";

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
  });

  const nodeWithPrefetch = (bookingContext: typeof meetings | null) =>
    createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        bookingContext,
      }),
    });

  it("attaches VISIT_CHANGE after «Мій запис» when visits exist (ignores wrong menu=default)", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: visitAsk,
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "ok",
      replyText: visitAsk,
      replyButtons: [...VISIT_CHANGE_MENU],
    });
  });

  it("replaces a stale «Мій запис» list with prefetch labels", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply:
        "Заплановані візити:\n🗓️ Консультація — завтра, 3 вересня (четвер) о 15:05\n\nБажаєте перенести або скасувати цей візит?",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyText).toBe(visitAsk);
    expect(update.messages).toEqual([expect.objectContaining({ content: visitAsk })]);
  });

  it("injects prefetch visits on «Головне меню» even when the model omitted the heading", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Привіт, Ada! Я ШІ-асистент.\n\nЧим можу допомогти?",
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
    expect(update.lastHandoff?.replyText).toContain("Чим можу допомогти?");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });


  it("attaches DEFAULT has-visits after «Головне меню» even when menu=visit_change", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Привіт! У вас є запланований візит. Чим можу допомогти?",
      menu: "visit_change",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
  });

  it("falls back to DEFAULT no-visits when «Мій запис» but list is empty", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Зараз не бачу запланованих візитів. Можу допомогти записатися?",
      menu: "visit_change",
    });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("attaches DEFAULT has-visits for menu=default when visits exist", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Будь ласка! Чим ще можу допомогти?",
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("дякую")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toBe("Будь ласка! Чим ще можу допомогти?");
    expect(update.lastHandoff?.replyText).not.toContain("Заплановані візити:");
  });

  it("attaches DEFAULT no-visits when menu is omitted on FINISH", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт! Чим можу допомогти?" });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("привіт")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("attaches VISIT_CHANGE when menu is omitted after «Мій запис» and visits exist", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: visitAsk });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...VISIT_CHANGE_MENU]);
  });

  it("builds visit list when FINISH omits reply on «Мій запис»", async () => {
    invoke.mockResolvedValue({ next: "FINISH", menu: "visit_change" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "ok",
      replyText: visitAsk,
      replyButtons: [...VISIT_CHANGE_MENU],
    });
    expect(update.messages).toEqual([expect.objectContaining({ content: visitAsk })]);
  });

  it("attaches DEFAULT has-visits when menu is omitted on a greeting and visits exist", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт! Чим можу допомогти?" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("привіт")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
    expect(update.lastHandoff?.replyText).toContain("Чим можу допомогти?");
  });

  it("strips a stray model trailer and still uses code-owned menu labels", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply:
        "Привіт, Тест!\n\n<reply_buttons>\nWrong\nLabels\n</reply_buttons>",
      menu: "default",
    });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyText).toBe("Привіт, Тест!");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
  });

  it("delivers routing failure via handoff only", async () => {
    const { PATIENT_FALLBACK_MESSAGE } = await import("../../shared/clinic-constants.js");
    invoke.mockResolvedValue({ next: "FINISH" });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("???")] }),
    );

    expect(update.messages).toBeUndefined();
    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: [...DEFAULT_MENU_NO_VISITS],
    });
  });
});

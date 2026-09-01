import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
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
    expect(system).toContain("visitLabels");
    expect(system).toContain("Консультація");
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
    expect(update.servicesContext).toBeUndefined();
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

describe("shouldContinueInBooking", () => {
  const bookingOffer = (labels: string[]) =>
    new AIMessage(
      `Який день?\n<reply_buttons>\n${labels.join("\n")}\n</reply_buttons>`,
    );

  it("is true when last handoff is booking/ok and the human taps an offered label", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
          messages: [bookingOffer(["25 серпня", "3 вересня", "Інша дата"]), new HumanMessage("25 серпня")],
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

  it("is false for supervisor-owned labels even when they appear in the trailer", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
          messages: [
            bookingOffer(["Так", "Обрати іншу процедуру"]),
            new HumanMessage("Обрати іншу процедуру"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
          messages: [
            bookingOffer(["Мій запис", "Послуги", "Адреса"]),
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
          lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
          messages: [bookingOffer(["25 серпня"]), new HumanMessage("а скільки коштує?")],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: { agentId: "faq", agentName: "FAQ", status: "ok" },
          messages: [bookingOffer(["25 серпня"]), new HumanMessage("25 серпня")],
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldContinueInFaq", () => {
  const faqOffer = (labels: string[]) =>
    new AIMessage(
      `Який напрямок?\n<reply_buttons>\n${labels.join("\n")}\n</reply_buttons>`,
    );

  it("is true when last handoff is faq/ok and the human taps an offered catalog label", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: { agentId: "faq", agentName: "FAQ", status: "ok" },
          messages: [
            faqOffer(["Ін'єкційні процедури", "Консультації та діагностика"]),
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
          lastHandoff: { agentId: "faq", agentName: "FAQ", status: "ok" },
          messages: [
            faqOffer(["Записатись", "Послуги", "Адреса"]),
            new HumanMessage("Послуги"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: { agentId: "faq", agentName: "FAQ", status: "ok" },
          messages: [faqOffer(["ботулінотерапія"]), new HumanMessage("а скільки коштує?")],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
          messages: [faqOffer(["ботулінотерапія"]), new HumanMessage("ботулінотерапія")],
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
        lastHandoff: { agentId: "faq", agentName: "FAQ", status: "ok" },
        messages: [
          new AIMessage(
            "Який напрямок?\n<reply_buttons>\nІн'єкційні процедури\n</reply_buttons>",
          ),
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
        lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
        messages: [
          new AIMessage(
            "Який день?\n<reply_buttons>\n25 серпня\nІнша дата\n</reply_buttons>",
          ),
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
        lastHandoff: { agentId: "booking", agentName: "Booking", status: "ok" },
        messages: [
          new AIMessage(
            "Який день?\n<reply_buttons>\n25 серпня\nІнша дата\n</reply_buttons>",
          ),
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

  it("attaches VISIT_CHANGE from menu=visit_change when visits exist", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: visitAsk,
      menu: "visit_change",
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

  it("falls back to DEFAULT no-visits when menu=visit_change but list is empty", async () => {
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
  });

  it("attaches DEFAULT no-visits when menu is omitted on FINISH", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт! Чим можу допомогти?" });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("привіт")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
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

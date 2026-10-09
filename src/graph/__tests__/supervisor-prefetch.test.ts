import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABANDON_BOOKING_REPLY_UK,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
  RETURN_TO_BOOKING_LABEL_UK,
  VISIT_CHANGE_MENU,
  VISIT_DECLINE_REPLY_UK,
} from "../../shared/clinic-constants.js";
import { createEmptyBookingDraft } from "../booking-draft.js";
import {
  openVisitNoteInteraction,
  visitMeetingChoiceLabel,
} from "../booking-session.js";
import { createAgentCommandPrepareNode } from "../agent-loop.js";
import type { ILLMConnector } from "../types.js";
import {
  agents,
  createCachedGeminiModel,
  createClinicSupervisorNode,
  isCachedContentNotFoundError,
  isPrefetchExpired,
  PREFETCH_TTL_MS,
  supervisorState,
} from "./supervisor-fixtures.js";

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
        modelName: "gemini-3.1-flash-lite",
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
        model: "models/gemini-3.1-flash-lite",
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
        modelName: "gemini-3.1-flash-lite",
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
          model: "models/gemini-3.1-flash-lite",
        })
        .mockResolvedValueOnce({
          cacheName: "caches/fresh",
          model: "models/gemini-3.1-flash-lite",
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
        modelName: "gemini-3.1-flash-lite",
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
          model: "models/gemini-3.1-flash-lite",
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
        modelName: "gemini-3.1-flash-lite",
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
      availabilityContext: null,
      availabilityCursor: null,
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
        messages: [new HumanMessage(MAIN_MENU_LABEL)],
        contactContext: { contacts: [{ id: "stale" }] },
        bookingContext: listedMeetings,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        availabilityCursor: {
          direction: "later",
          searchedThrough: "2026-08-25",
          firstDate: "2026-08-25",
          lastDate: "2026-08-25",
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
    expect(update.bookingDraft).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
    expect(update.selectedAvailabilityDate).toBeNull();
    expect(update.servicesContext).toBeUndefined();
    // Main menu starts a fresh booking session, so the durable cursor resets too.
    expect(update.availabilityCursor).toBeNull();
  });

  it("closes an active booking draft on Головне меню", async () => {
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
    const activeDraft = createEmptyBookingDraft();
    activeDraft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-1", name: "Процедура", source: "catalog" },
    };
    activeDraft.selectedDate = "2026-10-17";
    activeDraft.phase = "time";

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Головне меню")],
        bookingDraft: activeDraft,
        bookingNoteStatus: "answered",
        selectedAvailabilityDate: "2026-10-17",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(update.bookingDraft).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
    expect(update.selectedAvailabilityDate).toBeNull();
    expect(update.availabilityCursor).toBeNull();
  });

  it("preserves the availability cursor when prefetch expires during booking", async () => {
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
    const cursor = {
      direction: "later" as const,
      searchedThrough: "2026-10-05",
      firstDate: "2026-09-29",
      lastDate: "2026-10-05",
    };

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("другая дата")],
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["Інша дата"],
        },
        contactContext: listedContact,
        bookingContext: listedMeetings,
        availabilityContext: null,
        availabilityCursor: cursor,
        prefetchFetchedAt: Date.now() - 1_000,
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(update.next).toBe("booking");
    expect(update.availabilityContext).toBeNull();
    expect(update.availabilityCursor).toEqual(cursor);
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
        pendingInteraction: openVisitNoteInteraction(),
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
    invoke.mockResolvedValue({ next: "FINISH", reply: "Записів немає." });
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
    // Empty CRM list after refetch: no sticky cancel seed; LLM finishes.
    expect(update.next).toBe("FINISH");
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

  it("seeds a fresh cancel draft on Скасувати from the visit-change menu", async () => {
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
    expect(update.next).toBe("booking");
    expect(update.bookingDraft).toMatchObject({
      mode: "create",
      selectedSlot: null,
      note: { status: "unasked" },
      pendingCommand: { action: "cancel", payload: { meetingId: "m-1" } },
    });
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

  it("closes an active booking on Мій запис even when prefetch throws", async () => {
    const activeDraft = createEmptyBookingDraft();
    activeDraft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-1", name: "Процедура", source: "catalog" },
    };
    activeDraft.selectedDate = "2026-10-17";
    activeDraft.selectedSlot = {
      dateStart: "2026-10-17T11:00:00",
      dateEnd: "2026-10-17T11:30:00",
      label: "11:00",
    };
    activeDraft.phase = "note";
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => {
        throw new Error("CRM down");
      },
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Мій запис")],
        bookingDraft: activeDraft,
        bookingNoteStatus: "answered",
        selectedAvailabilityDate: "2026-10-17",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(update.next).toBe("FINISH");
    expect(update.prefetchDirty).toBe(true);
    expect(update.bookingDraft).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
    expect(update.selectedAvailabilityDate).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("abandons a slotless booking on Скасувати with a code-owned FINISH ack", async () => {
    const activeDraft = createEmptyBookingDraft();
    activeDraft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-1", name: "Процедура", source: "catalog" },
    };
    activeDraft.selectedDate = "2026-10-17";
    activeDraft.phase = "time";
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => {
        throw new Error("CRM down");
      },
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Скасувати")],
        bookingDraft: activeDraft,
        bookingNoteStatus: "awaiting",
        selectedAvailabilityDate: "2026-10-17",
        selectedSlot: null,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.replyText).toBe(ABANDON_BOOKING_REPLY_UK);
    expect(update.bookingDraft).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes an active booking on Головне меню when prefetch and routing both fail", async () => {
    const activeDraft = createEmptyBookingDraft();
    activeDraft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-1", name: "Процедура", source: "catalog" },
    };
    activeDraft.selectedDate = "2026-10-17";
    activeDraft.selectedSlot = {
      dateStart: "2026-10-17T11:00:00",
      dateEnd: "2026-10-17T11:30:00",
      label: "11:00",
    };
    activeDraft.phase = "note";
    invoke.mockRejectedValue(new Error("LLM down"));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => {
        throw new Error("CRM down");
      },
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Головне меню")],
        bookingDraft: activeDraft,
        bookingNoteStatus: "answered",
        selectedAvailabilityDate: "2026-10-17",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.status).toBe("error");
    expect(update.bookingDraft).toBeNull();
    expect(update.bookingNoteStatus).toBe("unasked");
    expect(update.selectedSlot).toBeNull();
    expect(update.selectedAvailabilityDate).toBeNull();
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


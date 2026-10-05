import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDetachedWorkRunner,
  handleGraphTextTurn,
  isCheckpointCorruptionError,
  PRIVATE_CHAT_ONLY,
  rejectNonPrivateTelegramChat,
  takeUserMessageSlot,
  clearUserMessageSlotsForTests,
  USER_MESSAGE_RATE_LIMIT,
  MAX_VOICE_DURATION_SECONDS,
  isVoiceDurationAllowed,
  withCheckpointThreadRetry,
  withTypingIndicator,
  wrapTelegramHandler,
} from "../telegram-bot.js";

describe("private chat restriction", () => {
  it("replies with a notice and does not proceed for group chats", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const rejected = await rejectNonPrivateTelegramChat({
      chat: { type: "group", id: -1 },
      reply,
    } as never);
    expect(rejected).toBe(true);
    expect(reply).toHaveBeenCalledWith(PRIVATE_CHAT_ONLY);
  });

  it("rejects supergroup and missing chat", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    expect(
      await rejectNonPrivateTelegramChat({
        chat: { type: "supergroup", id: -100 },
        reply,
      } as never),
    ).toBe(true);
    expect(reply).toHaveBeenCalledWith(PRIVATE_CHAT_ONLY);

    reply.mockClear();
    expect(
      await rejectNonPrivateTelegramChat({
        reply,
      } as never),
    ).toBe(true);
    expect(reply).not.toHaveBeenCalled();
  });

  it("allows private chats through", async () => {
    const reply = vi.fn();
    const rejected = await rejectNonPrivateTelegramChat({
      chat: { type: "private", id: 1 },
      reply,
    } as never);
    expect(rejected).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("per-user message rate limit", () => {
  afterEach(() => {
    clearUserMessageSlotsForTests();
  });

  it("allows 20 messages in a minute and rejects the 21st", () => {
    const start = 1_000_000;
    for (let i = 0; i < USER_MESSAGE_RATE_LIMIT; i += 1) {
      expect(takeUserMessageSlot("u-1", start + i)).toBe(true);
    }
    expect(takeUserMessageSlot("u-1", start + USER_MESSAGE_RATE_LIMIT)).toBe(false);
    expect(takeUserMessageSlot("u-2", start)).toBe(true);
  });

  it("resets after the window elapses", () => {
    const start = 2_000_000;
    for (let i = 0; i < USER_MESSAGE_RATE_LIMIT; i += 1) {
      expect(takeUserMessageSlot("u-1", start)).toBe(true);
    }
    expect(takeUserMessageSlot("u-1", start + 60_000)).toBe(true);
  });

  it("shares one bucket across text, voice, and /start (same user id)", () => {
    const start = 3_000_000;
    for (let i = 0; i < USER_MESSAGE_RATE_LIMIT - 1; i += 1) {
      expect(takeUserMessageSlot("u-start", start + i)).toBe(true);
    }
    // One slot left — a /start (or text/voice) tap consumes it; the next is blocked.
    expect(takeUserMessageSlot("u-start", start + USER_MESSAGE_RATE_LIMIT)).toBe(true);
    expect(takeUserMessageSlot("u-start", start + USER_MESSAGE_RATE_LIMIT + 1)).toBe(false);
  });
});

describe("voice duration cap", () => {
  it("allows notes up to 60 seconds and rejects longer", () => {
    expect(isVoiceDurationAllowed(MAX_VOICE_DURATION_SECONDS)).toBe(true);
    expect(isVoiceDurationAllowed(MAX_VOICE_DURATION_SECONDS + 1)).toBe(false);
  });
});

describe("text while HITL pending", () => {
  const InterruptState = Annotation.Root({
    result: Annotation<string>(),
    messages: Annotation<unknown[]>({
      reducer: (left: unknown[], right: unknown[]) => left.concat(right),
      default: () => [],
    }),
  });

  const buildPendingConfirmGraph = () =>
    new StateGraph(InterruptState)
      .addNode("ask", async () => {
        const decision = interrupt({
          type: "confirm_booking",
          draft: { confirmMessage: "Confirm?" },
        });
        return { result: JSON.stringify(decision) };
      })
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: new MemorySaver() });

  it("resumes pending interrupt with userReply and appends the text", async () => {
    const graph = buildPendingConfirmGraph();
    const threadId = "text-hitl-user-reply";
    const first = await graph.invoke(
      { result: "", messages: [] },
      { configurable: { thread_id: threadId } },
    );
    expect(first.__interrupt__).toBeDefined();

    const outbound = await handleGraphTextTurn(graph, threadId, "tg-1", "так");
    expect(outbound.reply_markup).toEqual({
      keyboard: [[{ text: "Головне меню" }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });

    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    expect(snap.next).toEqual([]);
    expect(JSON.parse(String(snap.values.result))).toEqual({ userReply: "так" });
    const texts = (snap.values.messages as Array<{ content?: unknown }>).map(
      (message) => message.content,
    );
    expect(texts).toContain("так");
    expect(
      (snap.tasks as Array<{ interrupts?: unknown[] }> | undefined)?.some(
        (task) => Array.isArray(task.interrupts) && task.interrupts.length > 0,
      ),
    ).toBeFalsy();
  });

  it("maps ✅/❌ reply-keyboard taps to confirmed resume payloads", async () => {
    const yesGraph = buildPendingConfirmGraph();
    const yesThread = "text-hitl-confirm-yes";
    await yesGraph.invoke(
      { result: "", messages: [] },
      { configurable: { thread_id: yesThread } },
    );
    await handleGraphTextTurn(yesGraph, yesThread, "tg-1", "✅");
    const yesSnap = await yesGraph.getState({ configurable: { thread_id: yesThread } });
    expect(JSON.parse(String(yesSnap.values.result))).toEqual({ confirmed: true });

    const noGraph = buildPendingConfirmGraph();
    const noThread = "text-hitl-confirm-no";
    await noGraph.invoke(
      { result: "", messages: [] },
      { configurable: { thread_id: noThread } },
    );
    await handleGraphTextTurn(noGraph, noThread, "tg-1", "❌");
    const noSnap = await noGraph.getState({ configurable: { thread_id: noThread } });
    expect(JSON.parse(String(noSnap.values.result))).toEqual({ confirmed: false });

    const menuGraph = buildPendingConfirmGraph();
    const menuThread = "text-hitl-confirm-menu";
    await menuGraph.invoke(
      { result: "", messages: [] },
      { configurable: { thread_id: menuThread } },
    );
    await handleGraphTextTurn(menuGraph, menuThread, "tg-1", "Головне меню");
    const menuSnap = await menuGraph.getState({ configurable: { thread_id: menuThread } });
    expect(JSON.parse(String(menuSnap.values.result))).toEqual({ confirmed: false });
  });
});

describe("booking schema upgrade on text turn", () => {
  const BookingState = Annotation.Root({
    result: Annotation<string>({
      reducer: (_left, right) => right,
      default: () => "",
    }),
    messages: Annotation<unknown[]>({
      reducer: (left: unknown[], right: unknown | unknown[]) =>
        left.concat(Array.isArray(right) ? right : [right]),
      default: () => [],
    }),
    bookingDraft: Annotation<unknown>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    bookingSchemaVersion: Annotation<number>({
      reducer: (_left, right) => right,
      default: () => 0,
    }),
    bookingNoteStatus: Annotation<string>({
      reducer: (_left, right) => right,
      default: () => "unasked",
    }),
    selectedSlot: Annotation<unknown>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    selectedAvailabilityDate: Annotation<string | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
  });

  const buildEchoGraph = () =>
    new StateGraph(BookingState)
      .addNode("echo", async (state) => ({
        result: `ok:${state.bookingSchemaVersion}`,
      }))
      .addEdge(START, "echo")
      .addEdge("echo", END)
      .compile({ checkpointer: new MemorySaver() });

  const buildPendingConfirmBookingGraph = () =>
    new StateGraph(BookingState)
      .addNode("ask", async (state) => {
        const decision = interrupt({
          type: "confirm_booking",
          draft: { confirmMessage: "Confirm?" },
        });
        return {
          result: JSON.stringify(decision),
          bookingSchemaVersion: state.bookingSchemaVersion,
        };
      })
      .addEdge(START, "ask")
      .addEdge("ask", END)
      .compile({ checkpointer: new MemorySaver() });

  it("upgrades a version-0 checkpoint once and leaves the second turn unchanged", async () => {
    const { setTrackEventForTests } = await import("../../analytics/track.js");
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    setTrackEventForTests((name, props) => {
      events.push({ name, props: props as Record<string, unknown> });
    });
    try {
      const graph = buildEchoGraph();
      const threadId = "booking-schema-v0";
      await graph.updateState(
        { configurable: { thread_id: threadId } },
        {
          bookingSchemaVersion: 0,
          bookingDraft: {
            version: 2,
            mode: "create",
            phase: "date",
            serviceAcceptance: {
              status: "accepted",
              service: { id: "svc-1", source: "catalog" },
            },
            selectedDate: null,
            selectedSlot: null,
            requestedTime: null,
            note: { status: "unasked" },
            contactId: null,
            pendingCommand: null,
            rescheduleTarget: null,
            replacement: null,
          },
          bookingNoteStatus: "awaiting",
          selectedAvailabilityDate: "2026-10-17",
        },
        "echo",
      );

      await handleGraphTextTurn(graph, threadId, "tg-1", "Привіт");
      const first = await graph.getState({ configurable: { thread_id: threadId } });
      expect(first.values.bookingSchemaVersion).toBe(1);
      expect(first.values.bookingNoteStatus).toBe("unasked");
      expect(first.values.selectedAvailabilityDate).toBeNull();
      expect(first.values.bookingDraft).toMatchObject({
        serviceAcceptance: { service: { id: "svc-1" } },
      });
      expect(events.filter((event) => event.name === "booking_checkpoint_migrated")).toHaveLength(1);

      events.length = 0;
      await handleGraphTextTurn(graph, threadId, "tg-1", "Ще раз");
      const second = await graph.getState({ configurable: { thread_id: threadId } });
      expect(second.values.bookingSchemaVersion).toBe(1);
      expect(second.values.bookingDraft).toEqual(first.values.bookingDraft);
      expect(events.filter((event) => event.name === "booking_checkpoint_migrated")).toHaveLength(0);
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("stamps schema version 1 on the first turn of a thread with no checkpoint", async () => {
    const { setTrackEventForTests } = await import("../../analytics/track.js");
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    setTrackEventForTests((name, props) => {
      events.push({ name, props: props as Record<string, unknown> });
    });
    try {
      const graph = buildEchoGraph();
      const threadId = "booking-schema-fresh";

      await handleGraphTextTurn(graph, threadId, "tg-1", "Привіт");
      const first = await graph.getState({ configurable: { thread_id: threadId } });
      expect(first.values.bookingSchemaVersion).toBe(1);
      expect(first.values.bookingDraft).toBeNull();
      expect(events.filter((event) => event.name === "booking_checkpoint_migrated")).toHaveLength(0);

      await handleGraphTextTurn(graph, threadId, "tg-1", "Ще раз");
      const second = await graph.getState({ configurable: { thread_id: threadId } });
      expect(second.values.bookingSchemaVersion).toBe(1);
      expect(events.filter((event) => event.name === "booking_checkpoint_migrated")).toHaveLength(0);
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("upgrades a version-0 interrupt via Command.update and still resumes confirm", async () => {
    const graph = buildPendingConfirmBookingGraph();
    const threadId = "booking-schema-v0-resume";
    const first = await graph.invoke(
      {
        result: "",
        messages: [],
        bookingSchemaVersion: 0,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "confirming",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
          selectedDate: "2026-10-17",
          selectedSlot: {
            dateStart: "2026-10-17T11:00:00",
            dateEnd: "2026-10-17T11:30:00",
            label: "11:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              dateStart: "2026-10-17T11:00:00",
              dateEnd: "2026-10-17T11:30:00",
            },
          },
          rescheduleTarget: null,
          replacement: null,
        },
        bookingNoteStatus: "skipped",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
      },
      { configurable: { thread_id: threadId } },
    );
    expect(first.__interrupt__).toBeDefined();

    await handleGraphTextTurn(graph, threadId, "tg-1", "✅");
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    expect(JSON.parse(String(snap.values.result))).toEqual({ confirmed: true });
    expect(snap.values.bookingSchemaVersion).toBe(1);
    expect(snap.values.bookingNoteStatus).toBe("unasked");
    expect(snap.values.selectedSlot).toBeNull();
    expect(snap.next).toEqual([]);
  });

  it("declines a pending confirm when migration fails closed", async () => {
    const graph = buildPendingConfirmBookingGraph();
    const threadId = "booking-schema-fail-closed-resume";
    const first = await graph.invoke(
      {
        result: "",
        messages: [],
        bookingSchemaVersion: 0,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "confirming",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "  ", source: "catalog" },
          },
          selectedDate: "2026-10-17",
          selectedSlot: {
            dateStart: "2026-10-17T11:00:00",
            dateEnd: "2026-10-17T11:30:00",
            label: "11:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: { action: "create", payload: {} },
          rescheduleTarget: null,
          replacement: null,
        },
        bookingNoteStatus: "skipped",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
      },
      { configurable: { thread_id: threadId } },
    );
    expect(first.__interrupt__).toBeDefined();

    await handleGraphTextTurn(graph, threadId, "tg-1", "✅");
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    expect(JSON.parse(String(snap.values.result))).toEqual({ confirmed: false });
    expect(snap.values.bookingSchemaVersion).toBe(1);
    expect(snap.values.bookingDraft).toBeNull();
    expect(snap.next).toEqual([]);
  });

  it("declines confirm when a confirming create has no selectedDate", async () => {
    const graph = buildPendingConfirmBookingGraph();
    const threadId = "booking-schema-confirming-null-date";
    const first = await graph.invoke(
      {
        result: "",
        messages: [],
        bookingSchemaVersion: 0,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "confirming",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
          selectedDate: null,
          selectedSlot: {
            dateStart: "2026-10-17T11:00:00",
            dateEnd: "2026-10-17T11:30:00",
            label: "11:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              dateStart: "2026-10-17T11:00:00",
              dateEnd: "2026-10-17T11:30:00",
            },
          },
          rescheduleTarget: null,
          replacement: null,
        },
        bookingNoteStatus: "skipped",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
          label: "11:00",
        },
      },
      { configurable: { thread_id: threadId } },
    );
    expect(first.__interrupt__).toBeDefined();

    await handleGraphTextTurn(graph, threadId, "tg-1", "✅");
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    expect(JSON.parse(String(snap.values.result))).toEqual({ confirmed: false });
    expect(snap.values.bookingSchemaVersion).toBe(1);
    expect(snap.values.bookingDraft).toMatchObject({
      serviceAcceptance: { service: { id: "svc-1" } },
      phase: "service",
      pendingCommand: null,
      selectedSlot: null,
      selectedDate: null,
    });
    expect(snap.next).toEqual([]);
  });
});

describe("checkpoint corruption retry", () => {
  it("matches serde/checkpoint errors only", () => {
    expect(isCheckpointCorruptionError(new Error("Failed to deserialize checkpoint"))).toBe(true);
    expect(isCheckpointCorruptionError(new Error("invalid checkpoint metadata"))).toBe(true);
    expect(isCheckpointCorruptionError(new Error("Unexpected token in JSON"))).toBe(true);
    expect(isCheckpointCorruptionError(new Error("MCP timeout"))).toBe(false);
    expect(isCheckpointCorruptionError("not-an-error")).toBe(false);
  });

  it("deleteThread + retries once when invoke throws a serde error", async () => {
    const deleteThread = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const graph = {
      getState: vi.fn().mockResolvedValue({ tasks: [] }),
      invoke: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Failed to deserialize checkpoint row");
        }
        return {
          messages: [{ _getType: () => "ai", content: "fresh start" }],
        };
      }),
    };

    const outbound = await handleGraphTextTurn(
      graph as never,
      "corrupt-thread",
      "tg-1",
      "Привіт",
      { deleteThread },
    );

    expect(deleteThread).toHaveBeenCalledWith("corrupt-thread");
    expect(attempts).toBe(2);
    expect(outbound.text).toContain("fresh start");
  });

  it("does not deleteThread for non-corruption errors", async () => {
    const deleteThread = vi.fn().mockResolvedValue(undefined);
    await expect(
      withCheckpointThreadRetry({ deleteThread }, "t-1", async () => {
        throw new Error("MCP timeout");
      }),
    ).rejects.toThrow("MCP timeout");
    expect(deleteThread).not.toHaveBeenCalled();
  });
});

describe("withTypingIndicator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends typing once immediately and returns the work result", async () => {
    const sendChatAction = vi.fn().mockResolvedValue(true);
    const result = await withTypingIndicator(
      { sendChatAction },
      42,
      async () => "done",
    );

    expect(result).toBe("done");
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatAction).toHaveBeenCalledWith(42, "typing");
  });

  it("clears the interval and rethrows when work fails", async () => {
    const sendChatAction = vi.fn().mockResolvedValue(true);
    await expect(
      withTypingIndicator({ sendChatAction }, 7, async () => {
        throw new Error("graph failed");
      }),
    ).rejects.toThrow("graph failed");
    expect(sendChatAction).toHaveBeenCalledTimes(1);
  });

  it("refreshes typing after 4s while work is still running", async () => {
    vi.useFakeTimers();
    const sendChatAction = vi.fn().mockResolvedValue(true);
    let resolveWork: (() => void) | undefined;
    const work = new Promise<string>((resolve) => {
      resolveWork = () => resolve("slow");
    });

    const pending = withTypingIndicator({ sendChatAction }, 1, () => work);
    await Promise.resolve();
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    resolveWork?.();
    await expect(pending).resolves.toBe("slow");
  });

  it("does not block work when sendChatAction fails", async () => {
    const sendChatAction = vi.fn().mockRejectedValue(new Error("network"));
    const result = await withTypingIndicator(
      { sendChatAction },
      3,
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});

describe("detached Telegram handlers", () => {
  it("returns from the Telegraf-facing wrapper before work resolves", async () => {
    const { runDetached, waitInflight } = createDetachedWorkRunner();
    let started = false;
    let finished = false;
    const handler = wrapTelegramHandler(runDetached, async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });

    handler(undefined);
    expect(started).toBe(true);
    expect(finished).toBe(false);

    await waitInflight();
    expect(finished).toBe(true);
  });

  it("runs two detached works concurrently", async () => {
    const { runDetached, waitInflight } = createDetachedWorkRunner();
    const order: string[] = [];

    const slow = wrapTelegramHandler(runDetached, async () => {
      order.push("slow-start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push("slow-end");
    });
    const fast = wrapTelegramHandler(runDetached, async () => {
      order.push("fast-start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("fast-end");
    });

    slow("chat-a");
    fast("chat-b");
    await waitInflight();

    expect(order).toEqual(["slow-start", "fast-start", "fast-end", "slow-end"]);
  });

  it("logs rejected work and does not surface an unhandled rejection", async () => {
    const { runDetached, waitInflight } = createDetachedWorkRunner();
    const error = new Error("graph failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      wrapTelegramHandler(runDetached, async () => {
        throw error;
      })(undefined);
      await waitInflight();
      expect(unhandled).toEqual([]);
      expect(log).toHaveBeenCalledWith("Telegram bot error:", error);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      log.mockRestore();
    }
  });
});

import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDetachedWorkRunner,
  handleGraphTextTurn,
  PRIVATE_CHAT_ONLY,
  rejectNonPrivateTelegramChat,
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
    expect(outbound.reply_markup).toBeUndefined();

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

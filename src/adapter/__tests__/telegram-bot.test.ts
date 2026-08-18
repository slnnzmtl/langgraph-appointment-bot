import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleGraphTextTurn, withTypingIndicator } from "../telegram-bot.js";

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

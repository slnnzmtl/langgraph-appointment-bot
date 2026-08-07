import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  estimateMessageTokens,
  getMessageHistoryMaxTokens,
  trimMessagesToTokenBudgetSync,
} from "./message-trimming.js";

describe("message-trimming", () => {
  it("getMessageHistoryMaxTokens defaults to 6000", () => {
    const prev = process.env.MESSAGE_HISTORY_MAX_TOKENS;
    delete process.env.MESSAGE_HISTORY_MAX_TOKENS;
    expect(getMessageHistoryMaxTokens()).toBe(6000);
    if (prev !== undefined) {
      process.env.MESSAGE_HISTORY_MAX_TOKENS = prev;
    }
  });

  it("returns messages unchanged when under budget", () => {
    const messages = [new HumanMessage("hi"), new AIMessage("hello")];
    expect(trimMessagesToTokenBudgetSync(messages, { maxTokens: 10_000 })).toEqual(messages);
  });

  it("keeps the latest human turn when trimming", () => {
    const messages = [
      new HumanMessage("old question with lots of padding text ".repeat(40)),
      new AIMessage("old answer with lots of padding text ".repeat(40)),
      new HumanMessage("latest"),
      new AIMessage("reply"),
    ];

    const trimmed = trimMessagesToTokenBudgetSync(messages, { maxTokens: 80 });
    expect(trimmed.some((m) => m instanceof HumanMessage && m.content === "latest")).toBe(true);
    expect(estimateMessageTokens(trimmed)).toBeLessThanOrEqual(
      estimateMessageTokens(messages),
    );
  });

  it("keeps an active tool-call batch intact", () => {
    const messages = [
      new HumanMessage("book"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "find_contact_by_telegram", args: {} }],
      }),
      new ToolMessage({ content: '{"id":"x"}', tool_call_id: "c1" }),
    ];

    const trimmed = trimMessagesToTokenBudgetSync(messages, { maxTokens: 1 });
    expect(trimmed.some((m) => m instanceof ToolMessage)).toBe(true);
    expect(trimmed.some((m) => m instanceof AIMessage)).toBe(true);
  });
});

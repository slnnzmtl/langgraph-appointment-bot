import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  applyDelegationPrompt,
  getRuntimeAgentIdFromMessage,
  RUNTIME_AGENT_CONTEXT_KEY,
  scopeSubAgentMessages,
  tagRuntimeAgentMessage,
} from "../sub-agent-messages.js";

describe("sub-agent-messages", () => {
  it("tagRuntimeAgentMessage stamps agent id", () => {
    const tagged = tagRuntimeAgentMessage(new AIMessage("done"), "faq");
    expect(getRuntimeAgentIdFromMessage(tagged)).toBe("faq");
    expect(tagged.additional_kwargs?.[RUNTIME_AGENT_CONTEXT_KEY]).toBe("faq");
  });

  it("scopeSubAgentMessages keeps only owned turns plus trailing human", () => {
    const faqReply = tagRuntimeAgentMessage(new AIMessage("hours are 9-18"), "faq");
    const bookingReply = tagRuntimeAgentMessage(new AIMessage("what day?"), "booking");
    const messages = [
      new HumanMessage("hours?"),
      faqReply,
      new HumanMessage("book tomorrow"),
      bookingReply,
      new HumanMessage("10:00"),
    ];

    const scoped = scopeSubAgentMessages(messages, "booking");
    expect(scoped.map((m) => m.getType())).toEqual(["human", "ai", "human"]);
    expect(getRuntimeAgentIdFromMessage(scoped[1]!)).toBe("booking");
    expect(scoped[2]).toBeInstanceOf(HumanMessage);
  });

  it("scopeSubAgentMessages drops foreign AI and its pending human", () => {
    const faqReply = tagRuntimeAgentMessage(new AIMessage("faq"), "faq");
    const messages = [
      new HumanMessage("faq q"),
      faqReply,
      new HumanMessage("book"),
    ];

    const scoped = scopeSubAgentMessages(messages, "booking");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toBeInstanceOf(HumanMessage);
    expect((scoped[0] as HumanMessage).content).toBe("book");
  });

  it("applyDelegationPrompt overwrites the last human text", () => {
    const messages = [
      new HumanMessage("original user text"),
      new AIMessage("prior"),
      new HumanMessage("latest user"),
    ];
    const next = applyDelegationPrompt(messages, "Book a cleaning tomorrow at 10");
    expect(next).toHaveLength(3);
    expect((next[2] as HumanMessage).content).toBe("Book a cleaning tomorrow at 10");
    expect((next[0] as HumanMessage).content).toBe("original user text");
  });

  it("applyDelegationPrompt prepends when history has no human", () => {
    const next = applyDelegationPrompt([new AIMessage("only ai")], "Do the task");
    expect(next[0]).toBeInstanceOf(HumanMessage);
    expect((next[0] as HumanMessage).content).toBe("Do the task");
  });
});

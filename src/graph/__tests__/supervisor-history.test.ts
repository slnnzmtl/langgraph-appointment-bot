import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { stripToolNoiseFromMessages } from "../supervisor-history.js";

describe("stripToolNoiseFromMessages", () => {
  it("drops ToolMessages", () => {
    const messages = [
      new HumanMessage("book"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "1", name: "list_services", args: {} }],
      }),
      new ToolMessage({ content: "{}", tool_call_id: "1", name: "list_services" }),
      new AIMessage("Which day?"),
    ];

    const stripped = stripToolNoiseFromMessages(messages);
    expect(stripped.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect((stripped[1] as AIMessage).content).toBe("Which day?");
  });

  it("strips tool_calls to a text AIMessage", () => {
    const messages = [
      new HumanMessage("hours?"),
      new AIMessage({
        content: "checking",
        tool_calls: [{ id: "1", name: "get_working_time", args: {} }],
      }),
    ];

    const stripped = stripToolNoiseFromMessages(messages);
    expect(stripped).toHaveLength(2);
    const ai = stripped[1] as AIMessage;
    expect(ai.content).toBe("checking");
    expect(ai.tool_calls ?? []).toHaveLength(0);
  });

  it("keeps human/AI turns across the thread", () => {
    const messages = [
      new HumanMessage("hours?"),
      new AIMessage("hours are 9-18"),
      new HumanMessage("book tomorrow"),
      new AIMessage("what day?"),
      new HumanMessage("10:00"),
    ];

    const stripped = stripToolNoiseFromMessages(messages);
    expect(stripped.map((m) => m.getType())).toEqual([
      "human",
      "ai",
      "human",
      "ai",
      "human",
    ]);
    expect((stripped[0] as HumanMessage).content).toBe("hours?");
    expect((stripped[4] as HumanMessage).content).toBe("10:00");
  });

  it("merges consecutive same-role messages", () => {
    const stripped = stripToolNoiseFromMessages([
      new HumanMessage("hello"),
      new HumanMessage("book tomorrow"),
      new AIMessage("ok"),
      new AIMessage("what time?"),
    ]);

    expect(stripped).toHaveLength(2);
    expect((stripped[0] as HumanMessage).content).toBe("hello\nbook tomorrow");
    expect((stripped[1] as AIMessage).content).toBe("ok\nwhat time?");
  });
});

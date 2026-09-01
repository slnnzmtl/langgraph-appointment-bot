import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  getRuntimeAgentIdFromMessage,
  RUNTIME_AGENT_CONTEXT_KEY,
  tagRuntimeAgentMessage,
} from "../sub-agent-messages.js";

describe("sub-agent-messages", () => {
  it("tagRuntimeAgentMessage stamps agent id", () => {
    const tagged = tagRuntimeAgentMessage(new AIMessage("done"), "booking");
    expect(getRuntimeAgentIdFromMessage(tagged)).toBe("booking");
    expect(tagged.additional_kwargs?.[RUNTIME_AGENT_CONTEXT_KEY]).toBe("booking");
  });
});

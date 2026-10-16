import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

/** Public ToolNode.invoke result when it returns a plain state patch (not Command). */
export type ToolNodeMessageUpdate = {
  messages: BaseMessage[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isToolNodeMessageUpdate = (
  result: unknown,
): result is ToolNodeMessageUpdate => {
  if (result instanceof Command || !isRecord(result)) {
    return false;
  }
  return Array.isArray(result.messages);
};

/**
 * Normalize ToolNode.invoke output for the agent tools boundary.
 * Rejects Command (agent loop must not branch on graph Commands here).
 */
export const toolMessagesFromToolNodeInvoke = (result: unknown): BaseMessage[] => {
  if (result instanceof Command) {
    throw new Error(
      "ToolNode returned a LangGraph Command; agent tools must return message updates only",
    );
  }
  if (!isToolNodeMessageUpdate(result)) {
    return [];
  }
  return result.messages;
};

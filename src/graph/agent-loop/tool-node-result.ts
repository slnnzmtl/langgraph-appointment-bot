import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

/** Public ToolNode.invoke result when it returns a plain state patch (not Command). */
export type ToolNodeMessageUpdate = {
  messages: ToolMessage[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToolMessageArray = (value: unknown): value is ToolMessage[] =>
  Array.isArray(value) && value.every((entry) => entry instanceof ToolMessage);

export const isToolNodeMessageUpdate = (
  result: unknown,
): result is ToolNodeMessageUpdate => {
  if (result instanceof Command || !isRecord(result)) {
    return false;
  }
  return isToolMessageArray(result.messages);
};

/**
 * Normalize ToolNode.invoke output for the agent tools boundary.
 * Fail closed: only message updates whose messages are ToolMessage results.
 */
export const toolMessagesFromToolNodeInvoke = (result: unknown): BaseMessage[] => {
  if (result instanceof Command) {
    throw new Error(
      "ToolNode returned a LangGraph Command; agent tools must return message updates only",
    );
  }
  if (Array.isArray(result)) {
    throw new Error(
      "ToolNode returned an array result; agent tools must return a message update only",
    );
  }
  if (!isToolNodeMessageUpdate(result)) {
    throw new Error(
      "ToolNode returned an unsupported result shape; expected { messages: ToolMessage[] }",
    );
  }
  return result.messages;
};

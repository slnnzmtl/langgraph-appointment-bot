import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";
import { hasPendingToolCalls } from "../tool-routing.js";

export const RUNTIME_TOOL_ORIGIN = "command_prepare" as const;

/** Stamp runtime-originated tool calls without PII or tool args. */
export const stampRuntimeToolAi = (
  toolName: string,
  toolCalls: NonNullable<AIMessage["tool_calls"]>,
  action?: string,
): AIMessage => {
  trackEvent("booking_runtime_tool", {
    tool: toolName,
    origin: RUNTIME_TOOL_ORIGIN,
    ...(action != null ? { action } : {}),
  });
  return new AIMessage({
    content: "",
    tool_calls: toolCalls,
    additional_kwargs: { runtimeToolOrigin: RUNTIME_TOOL_ORIGIN },
  });
};

export const isRuntimeOriginatedToolAi = (message: AIMessage): boolean =>
  message.additional_kwargs?.runtimeToolOrigin === RUNTIME_TOOL_ORIGIN;

/**
 * Add a runtime-owned tool call without breaking the AI/tool protocol. Replace
 * the latest AI message only while its tool call is still pending; after a
 * fulfilled prerequisite (for example slot revalidation), append the next call.
 */
export const appendOrReplacePendingToolCall = (
  messages: BaseMessage[],
  runtimeCall: AIMessage,
): BaseMessage[] => {
  if (!hasPendingToolCalls(messages)) {
    return [...messages, runtimeCall];
  }
  const lastAiIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message instanceof AIMessage)?.index;
  return lastAiIndex == null
    ? [...messages, runtimeCall]
    : [
        ...messages.slice(0, lastAiIndex),
        runtimeCall,
        ...messages.slice(lastAiIndex + 1),
      ];
};

/** Drop tool calls from the last AI message; shared with ToolNode protocol strip. */
export const rewriteAiToolCalls = (
  agentMessages: BaseMessage[],
  lastAiIndex: number,
  remainingCalls: NonNullable<AIMessage["tool_calls"]>,
): BaseMessage[] => {
  if (lastAiIndex < 0) {
    return agentMessages;
  }
  const lastAi = agentMessages[lastAiIndex] as AIMessage;
  const originalCalls = lastAi.tool_calls ?? [];
  if (remainingCalls.length === originalCalls.length) {
    return agentMessages;
  }
  return [
    ...agentMessages.slice(0, lastAiIndex),
    new AIMessage({
      content: lastAi.content,
      tool_calls: remainingCalls,
      additional_kwargs: lastAi.additional_kwargs,
      response_metadata: lastAi.response_metadata,
      id: lastAi.id,
    } as ConstructorParameters<typeof AIMessage>[0]),
    ...agentMessages.slice(lastAiIndex + 1),
  ];
};

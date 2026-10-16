import { AIMessage } from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";

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

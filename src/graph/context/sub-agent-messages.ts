import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export const RUNTIME_AGENT_CONTEXT_KEY = "runtimeAgentId" as const;
/** Marks a synthetic fallback AIMessage from a model/routing failure (not a real reply). */
export const MODEL_FAILURE_CONTEXT_KEY = "modelFailure" as const;

export const getRuntimeAgentIdFromMessage = (message: BaseMessage): string | undefined => {
  const value = message.additional_kwargs?.[RUNTIME_AGENT_CONTEXT_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const isModelFailureMessage = (message: BaseMessage): boolean =>
  message.additional_kwargs?.[MODEL_FAILURE_CONTEXT_KEY] === true;

export const tagRuntimeAgentMessage = (message: AIMessage, agentId: string): AIMessage => {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [RUNTIME_AGENT_CONTEXT_KEY]: agentId,
  };
  return message;
};

export const tagModelFailureMessage = (message: AIMessage): AIMessage => {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [MODEL_FAILURE_CONTEXT_KEY]: true,
  };
  return message;
};

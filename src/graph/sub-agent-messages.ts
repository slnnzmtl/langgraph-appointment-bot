import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export const RUNTIME_AGENT_CONTEXT_KEY = "runtimeAgentId" as const;

export const getRuntimeAgentIdFromMessage = (message: BaseMessage): string | undefined => {
  const value = message.additional_kwargs?.[RUNTIME_AGENT_CONTEXT_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const tagRuntimeAgentMessage = (message: AIMessage, agentId: string): AIMessage => {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [RUNTIME_AGENT_CONTEXT_KEY]: agentId,
  };
  return message;
};

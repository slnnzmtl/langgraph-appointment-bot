import { AIMessage, type BaseMessage } from "@langchain/core/messages";

/** Marks a synthetic fallback AIMessage from a model/routing failure (not a real reply). */
export const MODEL_FAILURE_CONTEXT_KEY = "modelFailure" as const;

export const isModelFailureMessage = (message: BaseMessage): boolean =>
  message.additional_kwargs?.[MODEL_FAILURE_CONTEXT_KEY] === true;

export const tagModelFailureMessage = (message: AIMessage): AIMessage => {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [MODEL_FAILURE_CONTEXT_KEY]: true,
  };
  return message;
};

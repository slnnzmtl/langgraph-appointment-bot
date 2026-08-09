import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

import { trimMessagesToTokenBudgetSync } from "./message-trimming.js";
import type { ClinicHandoff } from "./types.js";

export type ClinicStateAnnotationOptions = {
  messageHistoryMaxTokens: number;
};

export const createReduceClinicMessages = (messageHistoryMaxTokens: number) => (
  left: BaseMessage[],
  right: BaseMessage | BaseMessage[],
): BaseMessage[] =>
  trimMessagesToTokenBudgetSync(messagesStateReducer(left, right), {
    maxTokens: messageHistoryMaxTokens,
  });

export const createClinicStateAnnotation = ({
  messageHistoryMaxTokens,
}: ClinicStateAnnotationOptions) =>
  Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: createReduceClinicMessages(messageHistoryMaxTokens),
      default: () => [],
    }),
    agentMessages: Annotation<BaseMessage[]>({
      reducer: createReduceClinicMessages(messageHistoryMaxTokens),
      default: () => [],
    }),
    stepCount: Annotation<number>({
      reducer: (_left, right) => right,
      default: () => 0,
    }),
    next: Annotation<string | undefined>({
      reducer: (_left, right) => right,
      default: () => undefined,
    }),
    delegationPrompt: Annotation<string | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
    lastHandoff: Annotation<ClinicHandoff | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
  });

export type ClinicStateAnnotation = ReturnType<typeof createClinicStateAnnotation>;
export type ClinicState = ClinicStateAnnotation["State"];
export type ClinicStateUpdate = ClinicStateAnnotation["Update"];

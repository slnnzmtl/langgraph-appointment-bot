import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { AvailabilityContext } from "../tools/availability-tools.js";
import type { ServicesContext } from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";
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
    lastHandoff: Annotation<ClinicHandoff | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
    bookingContext: Annotation<BookingContext | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
    contactContext: Annotation<ContactLookupContext | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
    availabilityContext: Annotation<AvailabilityContext | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    servicesContext: Annotation<ServicesContext | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    prefetchDirty: Annotation<boolean>({
      reducer: (_left, right) => right,
      default: () => false,
    }),
    prefetchFetchedAt: Annotation<number | null>({
      reducer: (_left, right) => right ?? null,
      default: () => null,
    }),
  });

export type ClinicStateAnnotation = ReturnType<typeof createClinicStateAnnotation>;
export type ClinicState = ClinicStateAnnotation["State"];
export type ClinicStateUpdate = ClinicStateAnnotation["Update"];

import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { AvailabilityContext, AvailabilityCursor } from "../tools/availability-tools.js";
import type { ServicesContext } from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";
import { trimMessagesToTokenBudgetSync } from "./message-trimming.js";
import type { BookingNoteStatus, ClinicHandoff, SelectedBookingSlot } from "./types.js";
import type { BookingDraft } from "./booking-draft.js";

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
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    contactContext: Annotation<ContactLookupContext | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    availabilityContext: Annotation<AvailabilityContext | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /** Cursor metadata is durable across prefetch TTL refreshes; slot data is not. */
    availabilityCursor: Annotation<AvailabilityCursor | null>({
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
    /** @deprecated Kept only so old checkpoints can be read. BookingDraft is authoritative. */
    bookingNoteStatus: Annotation<BookingNoteStatus>({
      reducer: (_left, right) => right,
      default: () => "unasked",
    }),
    /** @deprecated Kept only so old checkpoints can be read. BookingDraft is authoritative. */
    selectedSlot: Annotation<SelectedBookingSlot | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /** @deprecated Kept only so old checkpoints can be read. BookingDraft is authoritative. */
    selectedAvailabilityDate: Annotation<string | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /** Authoritative checkpointed booking aggregate. New runtime writes must use this field. */
    bookingDraft: Annotation<BookingDraft | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
  });

export type ClinicStateAnnotation = ReturnType<typeof createClinicStateAnnotation>;
export type ClinicState = ClinicStateAnnotation["State"];
export type ClinicStateUpdate = ClinicStateAnnotation["Update"];

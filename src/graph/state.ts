import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { AvailabilityContext, AvailabilityCursor } from "../tools/availability-tools.js";
import type { ServicesContext } from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";
import { trimMessagesToTokenBudgetSync } from "./message-trimming.js";
import type { BookingNoteStatus, ClinicHandoff, SelectedBookingSlot } from "./types.js";
import type { BookingDecision } from "./booking-domain/decision.js";
import type { BookingDraft } from "./booking-draft.js";
import type { PendingInteraction } from "./booking-session.js";
import type { SupervisorIntent } from "./routing.js";

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
    /**
     * One-turn supervisor free-text intent for the specialist that runs next.
     * FAQ prepare opens the catalog when this is \`named_procedure\`. Cleared
     * after FAQ finalize (or when the supervisor routes elsewhere).
     */
    supervisorIntent: Annotation<SupervisorIntent | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
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
    /**
     * @deprecated Legacy checkpoint projection — migration / upgrade boundary only.
     * Live graph nodes must never write these; use `bookingDraft` instead.
     * Cleared on upgrade. Keep channels until production rows are already_current
     * (scanner) so versionless checkpoints can still be read and stamped.
     */
    bookingNoteStatus: Annotation<BookingNoteStatus>({
      reducer: (_left, right) => right,
      default: () => "unasked",
    }),
    /** @deprecated Migration boundary only — see bookingNoteStatus. */
    selectedSlot: Annotation<SelectedBookingSlot | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /** @deprecated Migration boundary only — see bookingNoteStatus. */
    selectedAvailabilityDate: Annotation<string | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /** Authoritative checkpointed booking aggregate. New runtime writes must use this field. */
    bookingDraft: Annotation<BookingDraft | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /**
     * Explicit patient response the workflow is waiting for. Booking-owned kinds
     * (visit_note, service_or_note, service_candidate) are opened only via
     * reduceBookingSession. Missing on old checkpoints reads as null.
     */
    pendingInteraction: Annotation<PendingInteraction | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /**
     * One-turn FAQ prepare evidence: true when this prepare produced catalog chips
     * or a service_confirm card. Cleared next prepare. Lets the router skip the FAQ
     * LLM without inferring a new offer from the current utterance.
     */
    faqSkipLlm: Annotation<boolean>({
      reducer: (_left, right) => right,
      default: () => false,
    }),
    /**
     * Booking checkpoint schema. 0 = unversioned legacy row or brand-new thread;
     * 2 = current atomic cutover. Missing channels read as 0.
     */
    bookingSchemaVersion: Annotation<number>({
      reducer: (_left, right) => right,
      default: () => 0,
    }),
    /**
     * Closed semantic decision for the non-authoritative booking__respond node.
     * Cleared after respond. Never written by the response model.
     */
    bookingDecision: Annotation<BookingDecision | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
    /**
     * Exact Telegram inline callback_data choice id for this turn.
     * Set by the adapter; consumed and cleared by booking__decide.
     */
    inboundChoiceId: Annotation<string | null>({
      reducer: (left, right) => (right === undefined ? left : right),
      default: () => null,
    }),
  });

export type ClinicStateAnnotation = ReturnType<typeof createClinicStateAnnotation>;
export type ClinicState = ClinicStateAnnotation["State"];
export type ClinicStateUpdate = ClinicStateAnnotation["Update"];

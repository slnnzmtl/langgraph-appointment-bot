/**
 * Facade for adapter-layer confirm-card resume. Keeps telegram-bot off graph/*.
 * Returns only the patient's decision (+ checkpoint upgrade); session transitions
 * belong to the graph after the meeting tool reports its outcome.
 */
import { HumanMessage } from "@langchain/core/messages";

import { classifyConfirmReply } from "../shared/confirm-reply.js";
import type { BookingDraft } from "../graph/booking/booking-draft.js";
import { hitlCommandsMatch } from "../graph/hitl-command-match.js";
import { recoverExpiredConfirmBookingHitl } from "../graph/booking/booking-hitl-recovery.js";
import {
  type PendingInteraction,
} from "../graph/booking/booking-session.js";
import { bookingResponseFallback } from "../graph/agent-loop/booking-response-fallback.js";

export type ConfirmBookingResume =
  | { confirmed: true }
  | { confirmed: false }
  | { left: true }
  | { userReply: string };

export type ConfirmBookingHitlResult = {
  resume: ConfirmBookingResume;
  /** Checkpoint upgrade (+ HumanMessage for chat/leave); no session patching. */
  update: Record<string, unknown>;
};

export type ResumeConfirmBookingHitlInput = {
  text: string;
  bookingDraft?: unknown;
  pendingInteraction?: unknown;
  bookingUpdate?: Record<string, unknown>;
  /** Exact callback_data choice id when the patient tapped an inline button. */
  callbackChoiceId?: string;
  /**
   * Paused LangGraph confirm_booking interrupt value. Required for identity
   * match before confirmed:true; missing → decline.
   */
  interruptValue?: unknown;
};

const asMutationConfirm = (
  pendingInteraction: unknown,
): PendingInteraction | null => {
  if (
    pendingInteraction != null
    && typeof pendingInteraction === "object"
    && (pendingInteraction as { kind?: string }).kind === "mutation_confirm"
  ) {
    return pendingInteraction as PendingInteraction;
  }
  return null;
};

const asBookingDraft = (value: unknown): BookingDraft | null => {
  if (value == null || typeof value !== "object") {
    return null;
  }
  return value as BookingDraft;
};

/**
 * Live HITL requires an unexpired mutation_confirm still stored on the draft
 * (pendingDecision.kind === mutation_confirm, or legacy pendingCommand + card).
 * After upgrade clears the frozen confirm, ✅ must never replay the write.
 */
export const hasLiveMutationConfirmHitl = (input: {
  bookingDraft?: unknown;
  pendingInteraction?: unknown;
}): boolean => {
  const draft = asBookingDraft(input.bookingDraft);
  if (draft == null) {
    return false;
  }
  if (draft.pendingDecision?.kind === "mutation_confirm") {
    return true;
  }
  const interaction = asMutationConfirm(input.pendingInteraction);
  return interaction != null && draft.pendingCommand != null;
};

/**
 * Interpret patient text / callback while a create/cancel/reschedule confirm is pending.
 */
export const resumeConfirmBookingHitl = (
  input: ResumeConfirmBookingHitlInput,
): ConfirmBookingHitlResult => {
  const bookingUpdate = input.bookingUpdate ?? {};
  const text = input.text;
  const callbackId = input.callbackChoiceId?.trim();
  const live = hasLiveMutationConfirmHitl({
    bookingDraft: input.bookingDraft,
    pendingInteraction: input.pendingInteraction,
  });

  const offered = asBookingDraft(input.bookingDraft)?.offeredChoiceIds ?? null;
  const exactCallback =
    callbackId != null
    && callbackId.length > 0
    && (offered == null || offered.includes(callbackId));

  if (callbackId === "menu" || callbackId === "main_menu") {
    return {
      resume: { left: true },
      update: {
        ...bookingUpdate,
        messages: [new HumanMessage(text || "menu")],
      },
    };
  }

  const tap = classifyConfirmReply(text);
  if (tap.kind === "leave") {
    return {
      resume: { left: true },
      update: {
        ...bookingUpdate,
        messages: [new HumanMessage(text)],
      },
    };
  }

  const confirmedViaCallback = exactCallback && (callbackId === "confirm" || callbackId === "hitl_yes");
  const declinedViaCallback = exactCallback && (callbackId === "decline" || callbackId === "hitl_no");
  const confirmedViaTap = tap.kind === "confirmed";
  const declinedViaTap = tap.kind === "declined";

  // Expired / migrated interrupt: never confirm a CRM write.
  if (
    !live
    && (confirmedViaCallback || declinedViaCallback || confirmedViaTap || declinedViaTap)
  ) {
    const recovered = recoverExpiredConfirmBookingHitl({
      bookingDraft: asBookingDraft(input.bookingDraft),
    });
    return {
      resume: { confirmed: false },
      update: {
        ...bookingUpdate,
        bookingDraft: recovered.bookingDraft,
        pendingInteraction: recovered.pendingInteraction,
        lastHandoff: {
          agentId: "booking",
          agentName: "booking",
          status: "ok",
          replyText: bookingResponseFallback({
            intent: recovered.fallbackIntent,
            facts: { clarificationReason: recovered.clarificationReason },
          }),
        },
      },
    };
  }

  if (live && (confirmedViaCallback || confirmedViaTap)) {
    // Full CRM command + effect id must match the paused interrupt.
    const draft = asBookingDraft(input.bookingDraft);
    if (!hitlCommandsMatch(draft, input.interruptValue)) {
      return { resume: { confirmed: false }, update: bookingUpdate };
    }
    return { resume: { confirmed: true }, update: bookingUpdate };
  }
  if (live && (declinedViaCallback || declinedViaTap)) {
    return { resume: { confirmed: false }, update: bookingUpdate };
  }

  return {
    resume: { userReply: text },
    update: {
      ...bookingUpdate,
      messages: [new HumanMessage(text)],
    },
  };
};

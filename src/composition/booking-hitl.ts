/**
 * Facade for adapter-layer confirm-card resume. Keeps telegram-bot off graph/*.
 * Returns only the patient's decision (+ checkpoint upgrade); session transitions
 * belong to the graph after the meeting tool reports its outcome.
 */
import { HumanMessage } from "@langchain/core/messages";

import { classifyConfirmReply } from "../shared/confirm-reply.js";
import {
  isConfirmationAffirmation,
  isConfirmationDecline,
} from "../shared/message-content.js";
import {
  interpretInteractionReply,
  type PendingInteraction,
} from "../graph/booking-session.js";
import { recoverExpiredConfirmBookingHitl } from "../graph/booking-hitl-recovery.js";
import type { BookingDraft } from "../graph/booking-draft.js";

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
 * Live HITL requires both the mutation_confirm card and a frozen pendingCommand.
 * After schema-2 hydration expires frozen HITL, ✅ must never replay the write.
 */
export const hasLiveMutationConfirmHitl = (input: {
  bookingDraft?: unknown;
  pendingInteraction?: unknown;
}): boolean => {
  const interaction = asMutationConfirm(input.pendingInteraction);
  const draft = asBookingDraft(input.bookingDraft);
  if (interaction == null || draft == null) {
    return false;
  }
  if (draft.pendingCommand == null) {
    return false;
  }
  if (draft.pendingDecision?.kind === "mutation_confirm") {
    return true;
  }
  // Legacy cards may still be live when pendingCommand is present.
  return true;
};

/**
 * Interpret patient text while a create/cancel/reschedule confirm card is pending.
 * Returns resume payload + Command.update (checkpoint upgrade; HumanMessage for chat).
 */
export const resumeConfirmBookingHitl = (
  input: ResumeConfirmBookingHitlInput,
): ConfirmBookingHitlResult => {
  const bookingUpdate = input.bookingUpdate ?? {};
  const mutationInteraction = asMutationConfirm(input.pendingInteraction);
  const text = input.text;
  const tap = classifyConfirmReply(text);
  const live = hasLiveMutationConfirmHitl({
    bookingDraft: input.bookingDraft,
    pendingInteraction: input.pendingInteraction,
  });

  // Main-menu leave works even if mutation_confirm was cleared mid-interrupt.
  if (tap.kind === "leave") {
    return {
      resume: { left: true },
      update: {
        ...bookingUpdate,
        messages: [new HumanMessage(text)],
      },
    };
  }

  // Expired / migrated interrupt: never confirm a CRM write. Decline the paused
  // ToolNode task and attach expired-confirmation recovery state.
  if (!live && (tap.kind === "confirmed" || tap.kind === "declined")) {
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
          replyText: recovered.replyText,
        },
        messages: [new HumanMessage(text)],
      },
    };
  }

  // Exact ✅/❌ taps are authoritative only while a live mutation_confirm exists.
  if (tap.kind === "confirmed") {
    return {
      resume: { confirmed: true },
      update: bookingUpdate,
    };
  }
  if (tap.kind === "declined") {
    return {
      resume: { confirmed: false },
      update: bookingUpdate,
    };
  }

  // NL affirm/decline still require an open mutation_confirm card.
  if (mutationInteraction == null || !live) {
    if (!live && mutationInteraction == null) {
      const recovered = recoverExpiredConfirmBookingHitl({
        bookingDraft: asBookingDraft(input.bookingDraft),
      });
      return {
        resume: { userReply: text },
        update: {
          ...bookingUpdate,
          bookingDraft: recovered.bookingDraft,
          pendingInteraction: recovered.pendingInteraction,
          lastHandoff: {
            agentId: "booking",
            agentName: "booking",
            status: "ok",
            replyText: recovered.replyText,
          },
          messages: [new HumanMessage(text)],
        },
      };
    }
    return {
      resume: { userReply: text },
      update: {
        ...bookingUpdate,
        messages: [new HumanMessage(text)],
      },
    };
  }

  const match = interpretInteractionReply(mutationInteraction, text);
  const action = mutationInteraction.kind === "mutation_confirm"
    ? mutationInteraction.action
    : undefined;
  if (
    match.kind === "choice" && match.choiceId === "confirm"
    || (action != null && isConfirmationAffirmation(text, action))
  ) {
    return {
      resume: { confirmed: true },
      update: bookingUpdate,
    };
  }
  if (
    match.kind === "choice" && match.choiceId === "decline"
    || isConfirmationDecline(text)
  ) {
    return {
      resume: { confirmed: false },
      update: bookingUpdate,
    };
  }

  return {
    resume: { userReply: text },
    update: {
      ...bookingUpdate,
      messages: [new HumanMessage(text)],
    },
  };
};

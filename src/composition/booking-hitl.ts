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
  if (tap.kind === "leave") {
    return {
      resume: { left: true },
      update: {
        ...bookingUpdate,
        messages: [new HumanMessage(text)],
      },
    };
  }

  if (mutationInteraction != null) {
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
  }

  return {
    resume: { userReply: text },
    update: {
      ...bookingUpdate,
      messages: [new HumanMessage(text)],
    },
  };
};

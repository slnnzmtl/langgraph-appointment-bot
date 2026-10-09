/**
 * Facade for adapter-layer confirm-card resume. Keeps telegram-bot off graph/*.
 */
import { classifyConfirmReply } from "../shared/confirm-reply.js";
import {
  isConfirmationAffirmation,
  isConfirmationDecline,
} from "../shared/message-content.js";
import type { BookingDraft } from "../graph/booking-draft.js";
import {
  interpretInteractionReply,
  reduceBookingSession,
  type PendingInteraction,
} from "../graph/booking-session.js";

export type ConfirmBookingResume =
  | { confirmed: true }
  | { confirmed: false }
  | { userReply: string };

export type ConfirmBookingHitlResult = {
  resume: ConfirmBookingResume;
  /** Booking-state patch merged with checkpoint upgrade; no chat messages. */
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

const asBookingDraft = (bookingDraft: unknown): BookingDraft | null =>
  bookingDraft != null && typeof bookingDraft === "object"
    ? bookingDraft as BookingDraft
    : null;

/**
 * Interpret patient text while a create/cancel/reschedule confirm card is pending.
 * Returns resume payload + booking-state update for Command; adapter appends HumanMessage.
 */
export const resumeConfirmBookingHitl = (
  input: ResumeConfirmBookingHitlInput,
): ConfirmBookingHitlResult => {
  const bookingUpdate = input.bookingUpdate ?? {};
  const mutationInteraction = asMutationConfirm(input.pendingInteraction);
  const bookingDraft = asBookingDraft(input.bookingDraft);
  const text = input.text;

  const interactionUpdate = (
    choiceId: "confirm" | "decline",
  ): Record<string, unknown> => {
    if (mutationInteraction == null) {
      return bookingUpdate;
    }
    const session = reduceBookingSession(
      {
        bookingDraft,
        pendingInteraction: mutationInteraction,
      },
      { type: "interaction_choice", choiceId },
    );
    return {
      ...bookingUpdate,
      bookingDraft: session.bookingDraft,
      pendingInteraction: choiceId === "confirm"
        ? session.pendingInteraction
        : null,
    };
  };

  const tap = classifyConfirmReply(text);
  if (tap.kind === "confirmed") {
    return {
      resume: { confirmed: true },
      update: interactionUpdate("confirm"),
    };
  }
  if (tap.kind === "declined" || tap.kind === "leave") {
    return {
      resume: { confirmed: false },
      update: interactionUpdate("decline"),
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
        update: interactionUpdate("confirm"),
      };
    }
    if (
      match.kind === "choice" && match.choiceId === "decline"
      || isConfirmationDecline(text)
    ) {
      return {
        resume: { confirmed: false },
        update: interactionUpdate("decline"),
      };
    }
    const session = reduceBookingSession(
      {
        bookingDraft,
        pendingInteraction: mutationInteraction,
      },
      { type: "mutation_chat_other" },
    );
    return {
      resume: { userReply: text },
      update: {
        ...bookingUpdate,
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      },
    };
  }

  return {
    resume: { userReply: text },
    update: bookingUpdate,
  };
};

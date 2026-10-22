/**
 * Legacy confirm_booking interrupt recovery.
 * Clearing pendingCommand in hydration does not retire a paused LangGraph interrupt.
 * On resume of an expired interrupt: do not CRM-write; expire confirmation and ask again.
 */
import type { BookingDraft } from "./booking-draft.js";
import type { PendingInteraction } from "./booking-session.js";

export type ExpiredConfirmRecovery = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
  /** Intent-keyed fallback id for the non-authoritative response table. */
  fallbackIntent: "clarification";
  clarificationReason: "expired_confirmation";
};

/**
 * Convert a resumed expired confirm_booking interrupt into recovery without
 * performing the CRM write. Draft is patched here only because the interrupt
 * resume path cannot re-enter reduceBookingDraft before ToolNode declines.
 */
export const recoverExpiredConfirmBookingHitl = (input: {
  bookingDraft: BookingDraft | null;
}): ExpiredConfirmRecovery => {
  const draft = input.bookingDraft;
  if (draft == null) {
    return {
      bookingDraft: null,
      pendingInteraction: null,
      fallbackIntent: "clarification",
      clarificationReason: "expired_confirmation",
    };
  }
  const recovered: BookingDraft = {
    ...draft,
    pendingCommand: null,
    pendingDecision: null,
    pendingEffect: null,
    offeredChoiceIds: null,
    slotProvenance: draft.selectedSlot != null ? "unverified_legacy" : null,
    slotEvidence: null,
    phase:
      draft.selectedDate != null
        ? "time"
        : draft.serviceAcceptance?.status === "accepted"
          ? "date"
          : "service",
  };
  return {
    bookingDraft: recovered,
    pendingInteraction: null,
    fallbackIntent: "clarification",
    clarificationReason: "expired_confirmation",
  };
};

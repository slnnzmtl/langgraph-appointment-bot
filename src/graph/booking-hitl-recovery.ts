/**
 * Legacy confirm_booking interrupt recovery (DDD-277 / 278A).
 * Clearing pendingCommand in hydration does not retire a paused LangGraph interrupt.
 * On resume of a legacy interrupt: do not CRM-write; expire confirmation and ask again.
 */
import type { BookingDraft } from "./booking-draft.js";
import type { PendingInteraction } from "./booking-session.js";

export type ExpiredConfirmRecovery = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
  replyText: string;
};

/**
 * Convert a resumed legacy confirm_booking interrupt into expired-confirmation
 * recovery without performing the CRM write.
 */
export const recoverExpiredConfirmBookingHitl = (input: {
  bookingDraft: BookingDraft | null;
  locale?: "uk" | "en";
}): ExpiredConfirmRecovery => {
  const draft = input.bookingDraft;
  if (draft == null) {
    return {
      bookingDraft: null,
      pendingInteraction: null,
      replyText: input.locale === "en"
        ? "That confirmation expired. Please start again."
        : "Підтвердження втратило чинність. Почнімо знову.",
    };
  }
  const recovered: BookingDraft = {
    ...draft,
    pendingCommand: null,
    pendingDecision: null,
    pendingEffect: null,
    slotProvenance: draft.selectedSlot != null ? "unverified_legacy" : null,
    slotEvidence: null,
    phase: draft.selectedDate != null ? "time" : draft.serviceAcceptance?.status === "accepted" ? "date" : "service",
  };
  return {
    bookingDraft: recovered,
    pendingInteraction: null,
    replyText: input.locale === "en"
      ? "That confirmation expired. Please confirm again after we refresh availability."
      : "Підтвердження втратило чинність. Підтвердіть ще раз після оновлення слотів.",
  };
};

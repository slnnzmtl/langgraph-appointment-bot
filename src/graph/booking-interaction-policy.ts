/**
 * Draft / interaction predicates for FAQ sticky and supervisor routing.
 * Replaces bookingTurnNeedsNoteOrchestrator without importing the deleted orchestrator.
 */

import type { BookingDraft } from "./booking-draft.js";
import type { PendingInteraction } from "./booking-session.js";

const BOOKING_OWNED_INTERACTION_KINDS = new Set([
  "visit_note",
  "service_or_note",
  "service_candidate",
  "catalog_detour",
  "date_select",
  "time_select",
]);

/**
 * True when the open draft / interaction should keep the patient in booking
 * (supervisor sticky) rather than re-routing to FAQ/idle.
 */
export const bookingTurnNeedsDraftInteraction = (state: {
  bookingDraft?: BookingDraft | null;
  pendingInteraction?: PendingInteraction | null;
}): boolean => {
  const interaction = state.pendingInteraction;
  if (interaction != null && BOOKING_OWNED_INTERACTION_KINDS.has(interaction.kind)) {
    // FAQ-owned catalog stays with FAQ sticky / catalog producer.
    if (interaction.kind === "service_candidate" && interaction.owner === "faq") {
      return false;
    }
    return true;
  }
  const draft = state.bookingDraft;
  if (draft == null || draft.mode === "reschedule") {
    return false;
  }
  if (
    draft.phase === "note"
    || (draft.selectedSlot != null
      && (draft.note.status === "awaiting" || draft.note.status === "unasked"))
  ) {
    return true;
  }
  return draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot == null
    && (draft.phase === "date" || draft.phase === "time");
};

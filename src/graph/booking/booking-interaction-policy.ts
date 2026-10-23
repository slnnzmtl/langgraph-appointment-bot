/**
 * Draft / interaction predicates for FAQ sticky and supervisor routing.
 * Ownership kinds come from booking-session — one list only.
 */

import { bookingDraftPhase, type BookingDraft } from "./booking-draft.js";
import {
  BOOKING_OWNED_INTERACTION_KINDS,
  type PendingInteraction,
} from "./booking-session.js";

const STICKY_INTERACTION_KINDS = new Set<string>([
  "visit_note",
  "service_or_note",
  "service_candidate",
  "catalog_detour",
  "date_select",
  "time_select",
]);

// Compile-time guard: sticky kinds must stay a subset of the session ownership list.
for (const kind of STICKY_INTERACTION_KINDS) {
  if (!(BOOKING_OWNED_INTERACTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`sticky interaction kind missing from BOOKING_OWNED_INTERACTION_KINDS: ${kind}`);
  }
}

/**
 * True when the open draft / interaction should keep the patient in booking
 * (supervisor sticky) rather than re-routing to FAQ/idle.
 */
export const bookingTurnNeedsDraftInteraction = (state: {
  bookingDraft?: BookingDraft | null;
  pendingInteraction?: PendingInteraction | null;
}): boolean => {
  const interaction = state.pendingInteraction;
  if (interaction != null && STICKY_INTERACTION_KINDS.has(interaction.kind)) {
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
  const phase = bookingDraftPhase(draft);
  if (
    phase === "note"
    || (draft.selectedSlot != null
      && (draft.note.status === "awaiting" || draft.note.status === "unasked"))
  ) {
    return true;
  }
  return draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot == null
    && (phase === "date" || phase === "time");
};

/**
 * Thin re-export of booking-session interaction types and helpers.
 * Prefer importing from booking-session.ts for new code.
 */
export {
  BOOKING_OWNED_INTERACTION_KINDS,
  clearBookingOwnedInteraction,
  isBookingOwnedInteraction,
  openVisitNoteInteraction,
  reduceBookingSession,
  type ApplyServiceChoiceEffect,
  type BookingOwnedInteractionKind,
  type BookingSessionEffect,
  type BookingSessionEvent,
  type BookingSessionReduction,
  type BookingSessionState,
  type InteractionChoice,
  type PendingInteraction,
  type ResolveServiceEffect,
  type ServiceCandidateInteraction,
  type ServiceOrNoteInteraction,
  type VisitNoteInteraction,
} from "./booking-session.js";

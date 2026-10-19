/**
 * Thin draft projections for supervisor sticky routing.
 * Note-ladder advances live in decideBooking; this module no longer mutates session cards.
 */

import type { ClinicState } from "../state.js";
import type { BookingNoteStatus, SelectedBookingSlot } from "../types.js";

export const authoritativeSelectedSlot = (state: ClinicState): SelectedBookingSlot | null =>
  state.bookingDraft?.selectedSlot ?? null;

export const authoritativeNoteStatus = (state: ClinicState): BookingNoteStatus =>
  state.bookingDraft?.note.status ?? "unasked";

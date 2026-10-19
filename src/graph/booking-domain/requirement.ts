import { bookingDraftPhase, type BookingDraft } from "../booking-draft.js";
import type { BookingReadModels } from "./decision.js";

/**
 * Workflow stage derived from the canonical {@link BookingDraft}. Replaces the
 * stored `BookingDraft.phase` projection as the single source of requirement.
 */
export type BookingRequirement =
  | "service"
  | "date"
  | "time"
  | "note"
  | "details"
  | "ready"
  | "confirming"
  | "none";

export type NextBookingRequirement = (
  draft: BookingDraft | null | undefined,
  readModels: BookingReadModels,
) => BookingRequirement;

/**
 * Pure derivation over the draft. `null`/empty draft has no active requirement.
 * `readModels` is accepted for signature symmetry with decideBooking but the
 * requirement itself is a function of the draft only.
 */
export const nextBookingRequirement: NextBookingRequirement = (draft) => {
  if (draft == null) {
    return "none";
  }
  return bookingDraftPhase(draft);
};

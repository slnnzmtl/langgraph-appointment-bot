import type { BookingReadModels } from "./decision.js";
import type { BookingSessionV2 } from "./session.js";

/**
 * Replaces stored BookingDraft.phase (Phase 1). Signature only in Phase 0.
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
  session: BookingSessionV2,
  readModels: BookingReadModels,
) => BookingRequirement;

/**
 * Compile-only placeholder. Phase 1 replaces stored phase with this derivation.
 * Must not be called from production routing in Phase 0.
 */
export const nextBookingRequirement: NextBookingRequirement = () => {
  throw new Error(
    "nextBookingRequirement is unused until DDD-273; do not call from production routing",
  );
};

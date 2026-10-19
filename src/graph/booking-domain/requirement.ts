import type { BookingReadModels } from "./decision.js";
import type { BookingSessionV2 } from "./session.js";

/**
 * Replaces stored BookingDraft.phase (Phase 1).
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
  readModels?: BookingReadModels,
) => BookingRequirement;

const hasVerifiedSlot = (session: BookingSessionV2): boolean => {
  const slot = session.selectedSlot;
  if (slot == null || slot.provenance !== "availability_tool") {
    return false;
  }
  // availability_tool without snapshot evidence is not mutation-ready.
  const snapshotId = slot.evidence?.snapshotId?.trim();
  return snapshotId != null && snapshotId.length > 0;
};

const contactPatchIncomplete = (session: BookingSessionV2): boolean => {
  const { contact } = session;
  if (contact.contactId == null) {
    return true;
  }
  const hasPatch =
    contact.phoneNumber != null
    || contact.firstName != null
    || contact.lastName != null;
  if (!hasPatch) {
    return false;
  }
  const missingPhone = contact.phoneNumber == null || contact.phoneNumber.trim() === "";
  const missingFirst = contact.firstName == null || contact.firstName.trim() === "";
  const missingLast = contact.lastName == null || contact.lastName.trim() === "";
  return missingPhone || missingFirst || missingLast;
};

/**
 * Deterministic next workflow requirement from canonical session + read models.
 * Does not invent CRM entities or consultation acceptance.
 */
export const nextBookingRequirement: NextBookingRequirement = (
  session,
  readModels,
) => {
  if (
    session.pendingDecision?.kind === "mutation_confirm"
    || session.pendingCommand != null
  ) {
    return "confirming";
  }
  if (session.mode === "reschedule") {
    if (session.rescheduleTarget == null) {
      return "service";
    }
    if (session.selectedDate == null) {
      return "date";
    }
    if (!hasVerifiedSlot(session)) {
      return "time";
    }
    if (readModels?.bookingContextDirty) {
      return "time";
    }
    return "ready";
  }
  if (
    session.serviceAcceptance == null
    || session.serviceAcceptance.status !== "accepted"
  ) {
    return "service";
  }
  if (session.selectedDate == null) {
    return "date";
  }
  if (!hasVerifiedSlot(session)) {
    return "time";
  }
  if (session.note.status !== "skipped" && session.note.status !== "answered") {
    return "note";
  }
  if (contactPatchIncomplete(session) || readModels?.contactContextDirty === true) {
    return "details";
  }
  return "ready";
};

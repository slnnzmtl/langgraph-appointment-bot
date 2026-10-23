import type { AvailabilityContext } from "../../tools/availability-tools.js";
import {
  bookingDraftPhase,
  bookingDraftCanPresentAvailability,
  effectiveBookingContactDetails,
  nextMissingContactField,
  type BookingDraft,
} from "./booking-draft.js";
import {
  buildDateSelectInteraction,
  buildEmptyAvailabilityInteraction,
  buildTimeSelectInteraction,
  availabilitySnapshotId,
} from "./booking-interaction-render.js";
import {
  openContactFieldInteraction,
  openServiceConfirmInteraction,
  openVisitNoteInteraction,
  openVisitReplacementInteraction,
  type PendingInteraction,
  type VisitSelectMeeting,
} from "./booking-session.js";
import type { ClinicHandoff } from "../types.js";

export type RestorePendingInteractionInput = {
  bookingDraft: BookingDraft | null | undefined;
  pendingInteraction: PendingInteraction | null | undefined;
  availabilityContext?: AvailabilityContext | null;
  contactContext?: {
    contacts?: Array<Record<string, unknown>>;
    ownership?: string;
  } | null;
  bookingContext?: {
    meetings: VisitSelectMeeting[];
  } | null;
  lastHandoff?: ClinicHandoff | null;
  /** True when contact/visit data was refreshed this turn. */
  prefetchFresh?: boolean;
};

/**
 * Idempotent restore when pendingInteraction is null.
 * Never restores mutation_confirm from pendingCommand alone.
 * Contact/visit restores require fresh prefetch when those contexts are involved.
 */
export const restorePendingInteraction = (
  input: RestorePendingInteractionInput,
): PendingInteraction | null => {
  if (input.pendingInteraction != null) {
    return input.pendingInteraction;
  }
  const draft = input.bookingDraft;
  if (draft == null) {
    return null;
  }
  const phase = bookingDraftPhase(draft);

  if (
    draft.replacement?.status === "offered"
    || draft.replacement?.status === "cancelling"
  ) {
    return openVisitReplacementInteraction(draft.replacement.meeting);
  }

  if (draft.selectedSlot != null && draft.note.status === "awaiting") {
    return openVisitNoteInteraction();
  }

  if (draft.serviceAcceptance?.status === "pending") {
    return openServiceConfirmInteraction(draft.serviceAcceptance.service);
  }

  if (
    (phase === "date" || phase === "time")
    && input.availabilityContext != null
    && bookingDraftCanPresentAvailability(draft)
  ) {
    const availability = input.availabilityContext;
    const open = availability.days.filter((day) => day.slots.length > 0);
    if (open.length === 0) {
      return buildEmptyAvailabilityInteraction(availability);
    }
    if (phase === "time" && draft.selectedDate != null) {
      const day = availability.days.find((entry) => entry.date === draft.selectedDate);
      if (day != null && day.slots.length > 0) {
        const interaction = buildTimeSelectInteraction(availability, day);
        if (interaction.snapshot.snapshotId === availabilitySnapshotId(availability)) {
          return interaction;
        }
      }
    }
    return buildDateSelectInteraction(availability);
  }

  if (
    // Stored phase is still needed here: a fresh Telegram-owned CRM contact can
    // have missing fields not yet copied into draft.contactDetails.
    draft.phase === "details"
    && input.prefetchFresh
    && draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot != null
    && (draft.note.status === "skipped" || draft.note.status === "answered")
  ) {
    const contacts = input.contactContext?.contacts ?? [];
    const owned = input.contactContext?.ownership === "telegram" && contacts.length > 0
      ? contacts[0]!
      : null;
    // pendingInteraction is null in this branch (early return above); fold only draft∪CRM.
    const effective = effectiveBookingContactDetails({
      crmContact: owned,
      contactDetails: draft.contactDetails ?? null,
    });
    const missing = nextMissingContactField(effective);
    if (missing == null) {
      // Complete accepted identity — do not reopen phoneNumber after a failed write.
      return null;
    }
    return openContactFieldInteraction(missing);
  }

  return null;
};

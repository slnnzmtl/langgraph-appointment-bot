import { contactMissingFields } from "../tools/contact-tools.js";
import type { AvailabilityContext } from "../tools/availability-tools.js";
import type { BookingDraft } from "./booking-draft.js";
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
import type { ClinicHandoff } from "./types.js";

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
    (draft.phase === "date" || draft.phase === "time")
    && input.availabilityContext != null
  ) {
    const availability = input.availabilityContext;
    const open = availability.days.filter((day) => day.slots.length > 0);
    if (open.length === 0) {
      return buildEmptyAvailabilityInteraction(availability);
    }
    if (draft.phase === "time" && draft.selectedDate != null) {
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
    draft.phase === "details"
    && input.prefetchFresh
    && draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot != null
    && (draft.note.status === "skipped" || draft.note.status === "answered")
  ) {
    const contacts = input.contactContext?.contacts ?? [];
    if (contacts.length === 0 || input.contactContext?.ownership !== "telegram") {
      return openContactFieldInteraction("phoneNumber");
    }
    const contact = contacts[0]!;
    const missing = contactMissingFields(contact)[0];
    if (missing === "firstName" || missing === "lastName" || missing === "phoneNumber") {
      return openContactFieldInteraction(missing);
    }
  }

  return null;
};

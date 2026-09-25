import type { SelectedBookingSlot } from "./types.js";

export type BookingMode = "create" | "reschedule" | "replace";

export type BookingPhase =
  | "service"
  | "date"
  | "time"
  | "note"
  | "details"
  | "ready"
  | "confirming";

export type BookingService = {
  id: string;
  name?: string;
  durationMinutes?: number;
  source: "catalog" | "direct" | "crm";
};

export type ServiceAcceptance = {
  status: "pending" | "accepted";
  service: BookingService;
  acceptedAtTurn?: number;
};

export type BookingNote = {
  status: "unasked" | "awaiting" | "skipped" | "answered";
  value?: string;
};

export type PendingBookingCommand = {
  action: BookingMode | "cancel";
  payload: Record<string, unknown>;
};

export type ReplacementMeeting = {
  id: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

export type ReplacementState = {
  meeting: ReplacementMeeting;
  status: "offered" | "cancelling" | "create_pending";
  originalCommand?: PendingBookingCommand;
};

export type LegacyBookingState = {
  bookingNoteStatus?: BookingNote["status"];
  selectedSlot?: SelectedBookingSlot | null;
  selectedAvailabilityDate?: string | null;
  /** A service may be supplied only when recovered from an unambiguous legacy checkpoint. */
  recoveredService?: BookingService;
};

export type BookingDraft = {
  version: number;
  mode: BookingMode;
  phase: BookingPhase;
  serviceAcceptance: ServiceAcceptance | null;
  selectedDate: string | null;
  selectedSlot: SelectedBookingSlot | null;
  note: BookingNote;
  contactId: string | null;
  pendingCommand: PendingBookingCommand | null;
  // Optional for checkpoints created before cancel-and-rebook was introduced.
  replacement?: ReplacementState | null;
};

export type BookingEvent =
  | { type: "service_selected"; service: BookingService; accepted?: boolean; turn?: number }
  | { type: "service_accepted"; turn?: number }
  | { type: "date_selected"; date: string }
  | { type: "slot_selected"; slot: SelectedBookingSlot }
  | { type: "note_status"; status: BookingNote["status"]; value?: string }
  | { type: "contact_resolved"; contactId: string }
  | { type: "command_prepared"; command: PendingBookingCommand }
  | { type: "existing_booking_detected"; meeting: ReplacementMeeting }
  | { type: "cancel_existing_requested"; command: PendingBookingCommand }
  | { type: "cancel_existing_completed" }
  | { type: "cancel_existing_declined" }
  | { type: "slot_invalidated"; keepDate?: boolean }
  | { type: "draft_abandoned" }
  | { type: "draft_resumed" };

export const migrateLegacyBookingState = (
  legacy: LegacyBookingState,
): BookingDraft | null => {
  const hasLegacyBooking =
    (legacy.bookingNoteStatus != null && legacy.bookingNoteStatus !== "unasked")
    || legacy.selectedSlot != null
    || legacy.selectedAvailabilityDate != null;
  if (!hasLegacyBooking || !legacy.recoveredService) {
    return null;
  }
  const noteStatus = legacy.bookingNoteStatus ?? (legacy.selectedSlot ? "awaiting" : "unasked");
  const selectedDate = legacy.selectedSlot?.dateStart.slice(0, 10)
    ?? legacy.selectedAvailabilityDate
    ?? null;
  return {
    version: 1,
    mode: "create",
    phase: legacy.selectedSlot
      ? noteStatus === "skipped" || noteStatus === "answered" ? "details" : "note"
      : selectedDate ? "time" : "service",
    serviceAcceptance: {
      status: "pending",
      service: legacy.recoveredService,
    },
    selectedDate,
    selectedSlot: legacy.selectedSlot ?? null,
    note: {
      status: noteStatus,
    },
    contactId: null,
    pendingCommand: null,
    replacement: null,
  };
};

export const createEmptyBookingDraft = (): BookingDraft => ({
  version: 0,
  mode: "create",
  phase: "service",
  serviceAcceptance: null,
  selectedDate: null,
  selectedSlot: null,
  note: { status: "unasked" },
  contactId: null,
  pendingCommand: null,
  replacement: null,
});

const withVersion = (draft: BookingDraft, update: Omit<BookingDraft, "version">): BookingDraft => ({
  ...update,
  version: draft.version + 1,
});

const clearDownstream = (draft: BookingDraft): Omit<BookingDraft, "version"> => ({
  ...draft,
  phase: "service",
  selectedDate: null,
  selectedSlot: null,
  note: { status: "unasked" },
  pendingCommand: null,
  replacement: null,
});

/**
 * The only place where booking-draft transitions are defined. UI/LLM layers emit
 * events; they do not mutate individual booking facts independently.
 */
export const reduceBookingDraft = (
  current: BookingDraft | null | undefined,
  event: BookingEvent,
): BookingDraft => {
  const draft = current ?? createEmptyBookingDraft();

  switch (event.type) {
    case "service_selected": {
      const existing = draft.serviceAcceptance;
      // Re-selecting/reaffirming the same service is not a service change. Keep
      // the date, slot, note, and command so an LLM retry or a patient restating
      // their choice cannot restart the booking ladder.
      if (existing?.service.id === event.service.id) {
        const accepted = existing.status === "accepted" || event.accepted === true;
        return withVersion(draft, {
          ...draft,
          serviceAcceptance: {
            ...existing,
            status: accepted ? "accepted" : existing.status,
            service: { ...existing.service, ...event.service },
            ...(accepted && event.turn != null ? { acceptedAtTurn: event.turn } : {}),
          },
          phase: accepted && draft.phase === "service" ? "date" : draft.phase,
        });
      }
      const reset = clearDownstream(draft);
      const acceptance: ServiceAcceptance = {
        status: event.accepted ? "accepted" : "pending",
        service: event.service,
        ...(event.accepted && event.turn != null ? { acceptedAtTurn: event.turn } : {}),
      };
      return withVersion(draft, {
        ...reset,
        serviceAcceptance: acceptance,
        phase: event.accepted ? "date" : "service",
      });
    }
    case "service_accepted": {
      if (!draft.serviceAcceptance) {
        return draft;
      }
      return withVersion(draft, {
        ...draft,
        serviceAcceptance: {
          ...draft.serviceAcceptance,
          status: "accepted",
          ...(event.turn != null ? { acceptedAtTurn: event.turn } : {}),
        },
        phase: "date",
      });
    }
    case "date_selected":
      return withVersion(draft, {
        ...draft,
        phase: "time",
        selectedDate: event.date,
        selectedSlot: null,
        pendingCommand: null,
      });
    case "slot_selected":
      return withVersion(draft, {
        ...draft,
        phase: "note",
        selectedDate: event.slot.dateStart.slice(0, 10),
        selectedSlot: event.slot,
        note: { status: "awaiting" },
        pendingCommand: null,
      });
    case "note_status":
      return withVersion(draft, {
        ...draft,
        phase: event.status === "skipped" || event.status === "answered" ? "details" : "note",
        note: {
          status: event.status,
          ...(event.value !== undefined ? { value: event.value } : {}),
        },
        pendingCommand: null,
      });
    case "contact_resolved":
      return withVersion(draft, { ...draft, contactId: event.contactId });
    case "command_prepared":
      return withVersion(draft, { ...draft, phase: "confirming", pendingCommand: event.command });
    case "existing_booking_detected": {
      const originalCommand =
        draft.pendingCommand?.action === "create" || draft.pendingCommand?.action === "reschedule"
          ? draft.pendingCommand
          : undefined;
      return withVersion(draft, {
        ...draft,
        mode: "replace",
        phase: "confirming",
        pendingCommand: null,
        replacement: {
          meeting: event.meeting,
          status: "offered",
          ...(originalCommand ? { originalCommand } : {}),
        },
      });
    }
    case "cancel_existing_requested":
      return withVersion(draft, {
        ...draft,
        mode: "replace",
        phase: "confirming",
        pendingCommand: event.command,
        replacement: draft.replacement
          ? { ...draft.replacement, status: "cancelling" }
          : null,
      });
    case "cancel_existing_completed":
      return withVersion(draft, {
        ...draft,
        mode: "create",
        phase: "confirming",
        pendingCommand: null,
        replacement: draft.replacement
          ? { ...draft.replacement, status: "create_pending" }
          : null,
      });
    case "cancel_existing_declined":
      // The existing appointment is still active; never leave a ready create
      // draft behind or the graph will immediately replay Already booked.
      return createEmptyBookingDraft();
    case "slot_invalidated":
      return withVersion(draft, {
        ...draft,
        phase: event.keepDate ? "time" : "date",
        selectedDate: event.keepDate ? draft.selectedDate : null,
        selectedSlot: null,
        // The selected time is invalid, not the patient's already supplied
        // note. Preserve the completed note/contact while asking only for a
        // replacement slot.
        note: draft.note,
        pendingCommand: null,
        // If the old meeting was already cancelled, the frozen replacement
        // command is no longer valid when its slot disappears. Build a fresh
        // command after the patient chooses another slot.
        replacement: draft.replacement?.status === "create_pending"
          ? null
          : (draft.replacement ?? null),
      });
    case "draft_resumed":
      return withVersion(draft, {
        ...draft,
        phase: draft.selectedSlot ? "note" : draft.selectedDate ? "time" : "service",
      });
    case "draft_abandoned":
      return createEmptyBookingDraft();
  }
};

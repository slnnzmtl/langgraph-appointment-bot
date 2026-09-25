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

export type AvailabilitySelection = {
  snapshotId: string;
  query?: string;
  expiresAt?: number;
};

export type BookingNote = {
  status: "unasked" | "awaiting" | "skipped" | "answered";
  value?: string;
};

export type PendingBookingCommand = {
  action: BookingMode;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  expiresAt: number;
};

export type BookingDraft = {
  version: number;
  mode: BookingMode;
  phase: BookingPhase;
  serviceAcceptance: ServiceAcceptance | null;
  availability: AvailabilitySelection | null;
  selectedDate: string | null;
  selectedSlot: SelectedBookingSlot | null;
  note: BookingNote;
  contactId: string | null;
  pendingCommand: PendingBookingCommand | null;
};

export type BookingEvent =
  | { type: "service_selected"; service: BookingService; accepted?: boolean; turn?: number }
  | { type: "service_accepted"; turn?: number }
  | { type: "availability_loaded"; snapshotId: string; query?: string }
  | { type: "date_selected"; date: string }
  | { type: "slot_selected"; slot: SelectedBookingSlot }
  | { type: "note_status"; status: BookingNote["status"]; value?: string }
  | { type: "contact_resolved"; contactId: string }
  | { type: "command_prepared"; command: PendingBookingCommand }
  | { type: "slot_invalidated"; keepDate?: boolean }
  | { type: "draft_abandoned" }
  | { type: "draft_resumed" };

export const createEmptyBookingDraft = (): BookingDraft => ({
  version: 0,
  mode: "create",
  phase: "service",
  serviceAcceptance: null,
  availability: null,
  selectedDate: null,
  selectedSlot: null,
  note: { status: "unasked" },
  contactId: null,
  pendingCommand: null,
});

const withVersion = (draft: BookingDraft, update: Omit<BookingDraft, "version">): BookingDraft => ({
  ...update,
  version: draft.version + 1,
});

const clearDownstream = (draft: BookingDraft): Omit<BookingDraft, "version"> => ({
  ...draft,
  phase: "service",
  availability: null,
  selectedDate: null,
  selectedSlot: null,
  note: { status: "unasked" },
  pendingCommand: null,
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
    case "availability_loaded":
      return withVersion(draft, {
        ...draft,
        availability: {
          snapshotId: event.snapshotId,
          ...(event.query ? { query: event.query } : {}),
        },
        phase: draft.selectedSlot ? draft.phase : "date",
      });
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
    case "slot_invalidated":
      return withVersion(draft, {
        ...draft,
        phase: event.keepDate ? "time" : "date",
        selectedDate: event.keepDate ? draft.selectedDate : null,
        selectedSlot: null,
        note: { status: "unasked" },
        pendingCommand: null,
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

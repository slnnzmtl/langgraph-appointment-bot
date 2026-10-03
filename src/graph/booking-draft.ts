import type { SelectedBookingSlot } from "./types.js";
import { CONSULTATION_SERVICE_ID } from "../shared/clinic-constants.js";

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

export type RequestedBookingTime = {
  value: string;
  status: "pending" | "unavailable";
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
  bookingDraft?: BookingDraft | null;
  bookingNoteStatus?: BookingNote["status"];
  selectedSlot?: SelectedBookingSlot | null;
  selectedAvailabilityDate?: string | null;
  /** A service may be supplied only when recovered from an unambiguous legacy checkpoint. */
  recoveredService?: BookingService;
};

export type BookingMigrationContext = {
  /** Human/assistant text retained in a legacy checkpoint, without tool payloads. */
  historyText?: readonly string[];
  /** Contact identity is safe to preserve independently of booking completion. */
  contactId?: string | null;
};

export type BookingDraft = {
  version: number;
  mode: BookingMode;
  phase: BookingPhase;
  serviceAcceptance: ServiceAcceptance | null;
  selectedDate: string | null;
  selectedSlot: SelectedBookingSlot | null;
  requestedTime: RequestedBookingTime | null;
  note: BookingNote;
  contactId: string | null;
  pendingCommand: PendingBookingCommand | null;
  /** CRM-owned meeting selected as the target of a direct reschedule. */
  rescheduleTarget?: ReplacementMeeting | null;
  // Optional for checkpoints created before cancel-and-rebook was introduced.
  replacement?: ReplacementState | null;
};

export type BookingEvent =
  | { type: "service_selected"; service: BookingService; accepted?: boolean; turn?: number }
  | { type: "service_accepted"; turn?: number }
  | { type: "date_selected"; date: string }
  | { type: "schedule_requested"; date: string; preferredTime?: string }
  | { type: "slot_selected"; slot: SelectedBookingSlot }
  | { type: "requested_time_unavailable" }
  | { type: "note_status"; status: BookingNote["status"]; value?: string }
  | { type: "contact_resolved"; contactId: string }
  | { type: "contact_unresolved" }
  | { type: "command_prepared"; command: PendingBookingCommand }
  | { type: "command_cleared" }
  | { type: "reschedule_started"; meeting: ReplacementMeeting | null }
  | { type: "existing_booking_detected"; meeting: ReplacementMeeting }
  | { type: "cancel_existing_requested"; command: PendingBookingCommand }
  | { type: "cancel_existing_completed" }
  | { type: "cancel_existing_declined" }
  | { type: "slot_invalidated"; keepDate?: boolean }
  | { type: "draft_abandoned" }
  | { type: "draft_resumed" };

const explicitConsultationAcceptance = (historyText: readonly string[]): boolean => {
  let consultationOffer = false;
  for (const raw of historyText) {
    const text = raw.trim();
    if (consultationOffer && /^(?:так|yes|так,?\s*запишіть)/iu.test(text)) {
      return true;
    }
    if (/консультац|consultation/i.test(text) && /\?|так|yes|запис/i.test(text)) {
      if (/[?]/.test(text)) {
        consultationOffer = true;
        continue;
      }
      if (/хочу\s+(?:на\s+)?консультац|запиш(?:іть|іть мене|атись|атися).*консультац|book.*consultation/i.test(text)) {
        return true;
      }
    }
    if (/^(?:ні|no|не хочу|інша процедура|another procedure)/iu.test(text)) {
      consultationOffer = false;
    }
  }
  return false;
};

const consultationOfferInHistory = (historyText: readonly string[]): boolean =>
  historyText.some((text) => /консультац|consultation/i.test(text) && /\?/u.test(text));

const draftHasValidServiceAcceptance = (draft: BookingDraft | null | undefined): boolean =>
  draft?.serviceAcceptance?.service?.id != null
  && (draft.serviceAcceptance.status === "accepted" || draft.serviceAcceptance.status === "pending");

export const bookingDraftPhase = (draft: BookingDraft): BookingPhase => {
  if (draft.phase === "confirming" && draft.pendingCommand != null) {
    return "confirming";
  }
  if (draft.mode === "reschedule") {
    if (draft.rescheduleTarget == null) return "service";
    if (draft.selectedDate == null) return "date";
    if (draft.selectedSlot == null) return "time";
    return "ready";
  }
  if (draft.serviceAcceptance == null || draft.serviceAcceptance.status !== "accepted") {
    return "service";
  }
  if (draft.selectedDate == null) {
    return "date";
  }
  if (draft.selectedSlot == null) {
    return "time";
  }
  if (draft.note.status !== "skipped" && draft.note.status !== "answered") {
    return "note";
  }
  if (draft.contactId == null) {
    return "details";
  }
  return "ready";
};

export const migrateLegacyBookingState = (
  legacy: LegacyBookingState,
  context: BookingMigrationContext = {},
): BookingDraft | null => {
  const existing = legacy.bookingDraft;
  const historyText = context.historyText ?? [];
  const hasLegacyBooking =
    (legacy.bookingNoteStatus != null && legacy.bookingNoteStatus !== "unasked")
    || legacy.selectedSlot != null
    || legacy.selectedAvailabilityDate != null
    || existing != null;
  if (!hasLegacyBooking && existing == null) {
    return null;
  }

  const source = existing ?? createEmptyBookingDraft();
  const currentAcceptance = draftHasValidServiceAcceptance(source)
    ? source.serviceAcceptance
    : null;
  const recoveredService = currentAcceptance?.service
    ?? legacy.recoveredService
    ?? null;
  const consultation = {
    id: CONSULTATION_SERVICE_ID,
    name: "Консультація",
    source: "direct" as const,
  } satisfies BookingService;
  const service = recoveredService
    ?? (explicitConsultationAcceptance(historyText) || consultationOfferInHistory(historyText)
      ? consultation
      : null);
  if (service == null) {
    return {
      ...createEmptyBookingDraft(),
      version: existing?.version ?? 0,
      contactId: existing?.contactId ?? context.contactId ?? null,
    };
  }
  const accepted = currentAcceptance?.status === "accepted"
    || explicitConsultationAcceptance(historyText);
  const selectedSlot = source.selectedSlot ?? legacy.selectedSlot ?? null;
  const retainedDate = source.selectedDate
    ?? selectedSlot?.dateStart.slice(0, 10)
    ?? legacy.selectedAvailabilityDate
    ?? null;
  const noteStatus = source.note.status !== "unasked"
    ? source.note.status
    : legacy.bookingNoteStatus ?? (legacy.selectedSlot ? "awaiting" : "unasked");
  const migrated: BookingDraft = {
    ...source,
    version: source.version,
    mode: source.mode ?? "create",
    serviceAcceptance: { status: accepted ? "accepted" : "pending", service },
    // A pending service is the only safe migration result when the checkpoint
    // contains an offer without acceptance. Do not carry facts that the
    // reducer would reject before accepted service evidence exists.
    selectedDate: accepted ? retainedDate : null,
    selectedSlot: accepted ? selectedSlot : null,
    requestedTime: source.requestedTime ?? null,
    note: {
      ...source.note,
      status: accepted ? noteStatus : "unasked",
    },
    contactId: source.contactId ?? context.contactId ?? null,
    pendingCommand: null,
    replacement: source.replacement ?? null,
  };
  return { ...migrated, phase: bookingDraftPhase(migrated) };
};

export const createEmptyBookingDraft = (): BookingDraft => ({
  version: 0,
  mode: "create",
  phase: "service",
  serviceAcceptance: null,
  selectedDate: null,
  selectedSlot: null,
  requestedTime: null,
  note: { status: "unasked" },
  contactId: null,
  pendingCommand: null,
  rescheduleTarget: null,
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
  requestedTime: null,
  note: { status: "unasked" },
  pendingCommand: null,
  rescheduleTarget: draft.rescheduleTarget ?? null,
  replacement: null,
});

const slotDate = (slot: SelectedBookingSlot): string => slot.dateStart.slice(0, 10);

const hasCompletedNote = (draft: BookingDraft): boolean =>
  draft.note.status === "skipped" || draft.note.status === "answered";

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
          phase: bookingDraftPhase({
            ...draft,
            serviceAcceptance: {
              ...existing,
              status: accepted ? "accepted" : existing.status,
              service: { ...existing.service, ...event.service },
            },
          }),
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
        phase: bookingDraftPhase({
          ...reset,
          serviceAcceptance: acceptance,
          version: draft.version,
        }),
      });
    }
    case "service_accepted": {
      if (!draft.serviceAcceptance || draft.serviceAcceptance.status === "accepted") {
        return draft;
      }
      const next = {
        ...draft,
        serviceAcceptance: {
          ...draft.serviceAcceptance,
          status: "accepted",
          ...(event.turn != null ? { acceptedAtTurn: event.turn } : {}),
        },
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "date_selected": {
      if (
        (draft.mode !== "reschedule" && draft.serviceAcceptance?.status !== "accepted")
        || (draft.mode === "reschedule" && draft.rescheduleTarget == null)
      ) {
        return draft;
      }
      const next = {
        ...draft,
        selectedDate: event.date,
        selectedSlot: null,
        requestedTime: null,
        pendingCommand: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "schedule_requested": {
      if (
        (draft.mode !== "reschedule" && draft.serviceAcceptance?.status !== "accepted")
        || (draft.mode === "reschedule" && draft.rescheduleTarget == null)
      ) {
        return draft;
      }
      const next = {
        ...draft,
        selectedDate: event.date,
        selectedSlot: null,
        requestedTime: event.preferredTime
          ? { value: event.preferredTime, status: "pending" as const }
          : null,
        pendingCommand: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "slot_selected": {
      if (
        (draft.mode !== "reschedule" && draft.serviceAcceptance?.status !== "accepted")
        || (draft.mode === "reschedule" && draft.rescheduleTarget == null)
        || draft.selectedDate == null
        || draft.selectedDate !== slotDate(event.slot)
      ) {
        return draft;
      }
      const next = {
        ...draft,
        selectedDate: slotDate(event.slot),
        selectedSlot: event.slot,
        requestedTime: null,
        note: draft.mode === "reschedule" ? draft.note : { status: "awaiting" },
        pendingCommand: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "requested_time_unavailable": {
      if (draft.requestedTime?.status !== "pending") {
        return draft;
      }
      const requestedTime = { ...draft.requestedTime, status: "unavailable" as const };
      const next = {
        ...draft,
        requestedTime,
        selectedSlot: null,
        pendingCommand: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "note_status": {
      if (draft.mode === "reschedule" || draft.selectedSlot == null) {
        return draft;
      }
      const next = {
        ...draft,
        note: {
          status: event.status,
          ...(event.value !== undefined ? { value: event.value } : {}),
        },
        pendingCommand: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, { ...next, phase: bookingDraftPhase({ ...next, version: draft.version }) });
    }
    case "contact_resolved":
      return withVersion(draft, { ...draft, contactId: event.contactId });
    case "contact_unresolved": {
      const next = { ...draft, contactId: null, pendingCommand: null };
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "reschedule_started":
      return withVersion(draft, {
        ...draft,
        mode: "reschedule",
        phase: event.meeting == null ? "service" : "date",
        serviceAcceptance: null,
        selectedDate: null,
        selectedSlot: null,
        requestedTime: null,
        note: { status: "unasked" },
        pendingCommand: null,
        rescheduleTarget: event.meeting,
        replacement: null,
      });
    case "command_prepared": {
      const requiresBookingAggregate = event.command.action === "create";
      if (
        requiresBookingAggregate
        && (
          draft.serviceAcceptance?.status !== "accepted"
          || draft.selectedSlot == null
          || !hasCompletedNote(draft)
          || draft.contactId == null
        )
      ) {
        return draft;
      }
      if (
        event.command.action === "reschedule"
        && (
          draft.mode !== "reschedule"
          || draft.rescheduleTarget == null
          || draft.selectedSlot == null
          || event.command.payload.meetingId !== draft.rescheduleTarget.id
          || event.command.payload.dateStart !== draft.selectedSlot.dateStart
          || event.command.payload.dateEnd !== draft.selectedSlot.dateEnd
        )
      ) {
        return draft;
      }
      const payload = event.command.payload;
      if (
        requiresBookingAggregate
        && (
          payload.serviceId !== draft.serviceAcceptance?.service.id
          || payload.contactId !== draft.contactId
          || payload.dateStart !== draft.selectedSlot?.dateStart
          || payload.dateEnd !== draft.selectedSlot?.dateEnd
        )
      ) {
        return draft;
      }
      return withVersion(draft, { ...draft, phase: "confirming", pendingCommand: event.command });
    }
    case "command_cleared":
      return withVersion(draft, {
        ...draft,
        pendingCommand: null,
        phase: bookingDraftPhase({ ...draft, pendingCommand: null, version: draft.version }),
      });
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
      return withVersion(draft, { ...draft, phase: bookingDraftPhase(draft) });
    case "draft_abandoned":
      return createEmptyBookingDraft();
  }
};

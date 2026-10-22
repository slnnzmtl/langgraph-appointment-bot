import { CLINIC_SLOT_MINUTES } from "../shared/clinic-constants.js";
import { normalizeClinicPhone } from "../shared/phone.js";
import { contactMissingFields } from "../tools/contact-tools.js";
import { kyivLocalIsoToUtcMs } from "../tools/availability-slots.js";
import type { SelectedBookingSlot } from "./types.js";

import type { PendingEffect, PendingEffectStatus } from "./booking-domain/effects.js";
import type {
  PendingDecision,
  SlotAvailabilityEvidence,
  SlotProvenance,
} from "./booking-domain/session.js";

export type { SlotAvailabilityEvidence, SlotProvenance };

/** Checkpoint schema stamped on ClinicState.bookingSchemaVersion (atomic cutover = 2). */
export const BOOKING_SCHEMA_VERSION = 2;

export type BookingContactField = "phoneNumber" | "firstName" | "lastName";

/**
 * Accepted patient identity pending CRM create/update/link.
 * Kept across link until the CRM row is complete; cleared only then.
 */
export type BookingContactDetails = {
  phoneNumber?: string; // normalized E.164
  firstName?: string;
  lastName?: string;
};

/** Typed find_contact_by_phone outcome for the exact accepted draft phone. */
export type PhoneLookupResult = "none" | "single_linkable" | "occupied" | "ambiguous";

export type PhoneLookupEvidence = {
  phoneNumber: string;
  result: PhoneLookupResult;
  contactIds: string[];
};

/** Allowed visit lengths for availability search and command guards (tool schema). */
const MIN_VISIT_DURATION_MINUTES = 15;
const MAX_VISIT_DURATION_MINUTES = 180;

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
  /** Durable accepted identity until CRM contact is complete. Optional on older checkpoints. */
  contactDetails?: BookingContactDetails | null;
  /** Last phone lookup for this draft's accepted phone. Optional on older checkpoints. */
  phoneLookupEvidence?: PhoneLookupEvidence | null;
  pendingCommand: PendingBookingCommand | null;
  /** CRM-owned meeting selected as the target of a direct reschedule. */
  rescheduleTarget?: ReplacementMeeting | null;
  // Optional for checkpoints created before cancel-and-rebook was introduced.
  replacement?: ReplacementState | null;
  /**
   * Irreducible wait owned by the aggregate (schema 2). Ordinary DATE/TIME/contact
   * cards stay projections only.
   */
  pendingDecision?: PendingDecision | null;
  /**
   * Provenance for selectedSlot. Missing on schema ≤1 rows; upgrade stamps
   * unverified_legacy. Runtime slot selection stamps availability_tool.
   */
  slotProvenance?: SlotProvenance | null;
  /**
   * Snapshot/service/duration/exclusion proof for a verified slot.
   * Required alongside availability_tool provenance for mutation-ready slots.
   */
  slotEvidence?: SlotAvailabilityEvidence | null;
  /**
   * At most one pending effect (prepared→executing→completed/unknown).
   * Persisted for crash-safe emit-once correlation.
   */
  pendingEffect?: PendingEffect | null;
  /**
   * Exact Telegram callback_data choice ids currently offered on the booking card.
   * Callbacks not in this set are rejected; reply-keyboard labels are never matched.
   */
  offeredChoiceIds?: string[] | null;
};

export type BookingEvent =
  | { type: "service_selected"; service: BookingService; accepted?: boolean; turn?: number }
  | { type: "service_accepted"; turn?: number }
  | { type: "date_selected"; date: string }
  | { type: "schedule_requested"; date: string; preferredTime?: string }
  | {
      type: "slot_selected";
      slot: SelectedBookingSlot;
      /** Availability snapshot id when known; otherwise a runtime marker is stamped. */
      snapshotId?: string;
    }
  | { type: "requested_time_unavailable" }
  | { type: "note_status"; status: BookingNote["status"]; value?: string }
  | {
      type: "contact_field_submitted";
      field: BookingContactField;
      value: string;
    }
  | { type: "contact_resolved"; contactId: string; clearDetails?: boolean }
  | { type: "contact_details_cleared" }
  | { type: "phone_lookup_recorded"; evidence: PhoneLookupEvidence }
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
  | { type: "draft_resumed" }
  // Schema-2 atomic cutover: pending effect + decision + slot provenance.
  | { type: "effect_prepared"; effect: PendingEffect }
  | { type: "effect_status"; status: PendingEffectStatus }
  | { type: "effect_cleared" }
  | { type: "decision_set"; decision: PendingDecision }
  | { type: "decision_cleared" }
  | {
      type: "slot_provenance_set";
      provenance: SlotProvenance;
      evidence?: SlotAvailabilityEvidence | null;
    }
  | { type: "choices_offered"; choiceIds: string[] }
  | { type: "choices_cleared" };

/**
 * Patient-submit name normalize: trim only. Preserve submitted casing.
 * Write path only — not CRM merge/read.
 */
const normalizeContactName = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Ladder order for patient identity collection (phone before names). */
const CONTACT_LADDER_FIELDS = ["phoneNumber", "firstName", "lastName"] as const;

const contactFieldFromUnknown = (
  value: unknown,
  field: BookingContactField,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  if (field === "phoneNumber") {
    return normalizeClinicPhone(value) ?? undefined;
  }
  // Merge/read: keep CRM casing; only drop blanks.
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const mergeContactFields = (
  target: BookingContactDetails,
  source: Record<string, unknown> | BookingContactDetails | null | undefined,
  fields: readonly BookingContactField[],
  onlyGaps: boolean,
): void => {
  if (source == null) {
    return;
  }
  for (const field of fields) {
    if (onlyGaps && target[field] != null) {
      continue;
    }
    const value = contactFieldFromUnknown(source[field], field);
    if (value != null) {
      target[field] = value;
    }
  }
};

/**
 * Effective accepted identity: owned CRM row, then draft contactDetails (wins),
 * then per-field gaps from leftover contact_field.collected.
 */
export const effectiveBookingContactDetails = (input: {
  crmContact?: Record<string, unknown> | null;
  contactDetails?: BookingContactDetails | null;
  collected?: { firstName?: string; lastName?: string } | null;
}): BookingContactDetails => {
  const merged: BookingContactDetails = {};
  mergeContactFields(merged, input.crmContact, CONTACT_LADDER_FIELDS, false);
  mergeContactFields(merged, input.contactDetails, CONTACT_LADDER_FIELDS, false);
  mergeContactFields(merged, input.collected, ["firstName", "lastName"], true);
  return merged;
};

/** First required identity field still missing/invalid on the effective details. */
export const nextMissingContactField = (
  details: BookingContactDetails,
): BookingContactField | null => {
  const missing = new Set(contactMissingFields(details as Record<string, unknown>));
  for (const field of CONTACT_LADDER_FIELDS) {
    if (missing.has(field)) {
      return field;
    }
  }
  return null;
};

/**
 * Authoritative availability query scope derived from the booking draft.
 * Create/replace use the accepted service; reschedule uses the CRM visit span
 * and excludes that meeting as busy.
 */
export type BookingAvailabilityScope = {
  durationMinutes?: number;
  excludeMeetingIds?: string[];
  serviceId?: string;
};

/** Minimal availability snapshot fields needed to decide trust. */
export type AvailabilityBookingTrust = {
  serviceId?: string;
  stepMinutes: number;
  excludeMeetingIds?: string[];
  days?: Array<{ slots: Array<{ dateStart: string; dateEnd: string }> }>;
};

const boundedVisitDurationMinutes = (minutes: number): number | undefined =>
  Number.isFinite(minutes)
    && minutes >= MIN_VISIT_DURATION_MINUTES
    && minutes <= MAX_VISIT_DURATION_MINUTES
    ? Math.round(minutes)
    : undefined;

/** Span of two Kyiv-local CRM datetimes in minutes, or undefined when invalid. */
const visitSpanMinutes = (
  dateStart: string | null | undefined,
  dateEnd: string | null | undefined,
): number | undefined => {
  if (typeof dateStart !== "string" || typeof dateEnd !== "string") {
    return undefined;
  }
  if (!dateStart.trim() || !dateEnd.trim()) {
    return undefined;
  }
  try {
    const minutes = (kyivLocalIsoToUtcMs(dateEnd) - kyivLocalIsoToUtcMs(dateStart)) / 60_000;
    return boundedVisitDurationMinutes(minutes);
  } catch {
    return undefined;
  }
};

/**
 * Visit length owned by the booking draft: accepted service duration for
 * create/replace, or the CRM meeting span for a direct reschedule.
 */
export const bookingVisitDurationMinutes = (
  draft: BookingDraft | null | undefined,
): number | undefined => {
  if (draft == null) {
    return undefined;
  }
  if (draft.mode === "reschedule") {
    const target = draft.rescheduleTarget;
    return visitSpanMinutes(target?.dateStart, target?.dateEnd);
  }
  const accepted = draft.serviceAcceptance?.status === "accepted"
    ? draft.serviceAcceptance.service
    : null;
  if (accepted?.durationMinutes == null) {
    return undefined;
  }
  return boundedVisitDurationMinutes(accepted.durationMinutes);
};

/** Duration + excludeMeetingIds (+ serviceId) for every availability request. */
export const bookingAvailabilityScope = (
  draft: BookingDraft | null | undefined,
): BookingAvailabilityScope => {
  if (draft == null) {
    return {};
  }
  const durationMinutes = bookingVisitDurationMinutes(draft);
  if (draft.mode === "reschedule") {
    const meetingId = draft.rescheduleTarget?.id?.trim();
    return {
      ...(durationMinutes != null ? { durationMinutes } : {}),
      ...(meetingId ? { excludeMeetingIds: [meetingId] } : {}),
    };
  }
  const accepted = draft.serviceAcceptance?.status === "accepted"
    ? draft.serviceAcceptance.service
    : null;
  if (accepted == null) {
    return {};
  }
  const serviceId = accepted.id.trim();
  return {
    ...(serviceId ? { serviceId } : {}),
    ...(durationMinutes != null ? { durationMinutes } : {}),
  };
};

/** Tool-arg fields from the draft scope (duration + excluded meetings only). */
export const availabilityRequestFieldsFromDraft = (
  draft: BookingDraft | null | undefined,
): Pick<BookingAvailabilityScope, "durationMinutes" | "excludeMeetingIds"> => {
  const scope = bookingAvailabilityScope(draft);
  return {
    ...(scope.durationMinutes != null ? { durationMinutes: scope.durationMinutes } : {}),
    ...(scope.excludeMeetingIds?.length
      ? { excludeMeetingIds: scope.excludeMeetingIds }
      : {}),
  };
};

const sameExcludeMeetingIds = (
  left: string[] | undefined,
  right: string[] | undefined,
): boolean => {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
};

/** True when every presented slot spans exactly `expectedDuration` minutes. */
const snapshotSlotsMatchDuration = (
  availability: AvailabilityBookingTrust,
  expectedDuration: number,
): boolean => {
  const days = availability.days;
  if (days == null || days.length === 0) {
    return false;
  }
  let sawSlot = false;
  for (const day of days) {
    for (const slot of day.slots) {
      sawSlot = true;
      if (visitSpanMinutes(slot.dateStart, slot.dateEnd) !== expectedDuration) {
        return false;
      }
    }
  }
  return sawSlot;
};

/**
 * Whether a checkpointed availability snapshot may be reused for this draft.
 * Compatible serviceId (current rule), matching excludeMeetingIds, and a
 * duration that matches either stepMinutes or the presented slot spans
 * (legacy checkpoints stored start cadence in stepMinutes). Null availability
 * is treated as matching (no snapshot).
 */
export const availabilityMatchesBooking = (
  availability: AvailabilityBookingTrust | null | undefined,
  draft: BookingDraft | null | undefined,
): boolean => {
  if (availability == null) {
    return true;
  }
  const scope = bookingAvailabilityScope(draft);
  if (
    availability.serviceId != null
    && scope.serviceId != null
    && availability.serviceId !== scope.serviceId
  ) {
    return false;
  }
  if (!sameExcludeMeetingIds(availability.excludeMeetingIds, scope.excludeMeetingIds)) {
    return false;
  }
  const expectedDuration = scope.durationMinutes ?? CLINIC_SLOT_MINUTES;
  if (availability.stepMinutes === expectedDuration) {
    return true;
  }
  return snapshotSlotsMatchDuration(availability, expectedDuration);
};

/**
 * True when present_availability_slots / DATE/TIME UI are legal for this draft.
 * Create needs an accepted service with a nonblank id; reschedule needs a target id.
 */
export const bookingDraftCanPresentAvailability = (
  draft: BookingDraft | null | undefined,
): boolean => {
  if (draft == null) {
    return false;
  }
  if (draft.mode === "reschedule") {
    const id = draft.rescheduleTarget?.id;
    return typeof id === "string" && id.trim().length > 0;
  }
  if (draft.mode !== "create") {
    return false;
  }
  const id = draft.serviceAcceptance?.service?.id;
  return draft.serviceAcceptance?.status === "accepted"
    && typeof id === "string"
    && id.trim().length > 0;
};
/**
 * Checkpoint-read compatibility only. An empty object left by older abandon
 * paths is not an active session — canonicalize it to null before the turn.
 * Runtime code must never persist another empty draft.
 */
export const isEmptyLegacyBookingDraft = (
  draft: BookingDraft | null | undefined,
): boolean =>
  draft != null
  && draft.mode === "create"
  && draft.serviceAcceptance == null
  && draft.selectedDate == null
  && draft.selectedSlot == null
  && draft.requestedTime == null
  && draft.note?.status === "unasked"
  && draft.note?.value == null
  && draft.pendingCommand == null
  && draft.rescheduleTarget == null
  && draft.replacement == null;

/** True when selectedSlot may drive progression (runtime-stamped with evidence). */
const draftHasVerifiedSlot = (draft: BookingDraft): boolean => {
  if (draft.selectedSlot == null || draft.slotProvenance !== "availability_tool") {
    return false;
  }
  const snapshotId = draft.slotEvidence?.snapshotId?.trim();
  return snapshotId != null && snapshotId.length > 0;
};

/** Build slot evidence from the draft availability scope + optional snapshot id. */
export const slotEvidenceForSelection = (
  draft: BookingDraft,
  slot: SelectedBookingSlot,
  snapshotId?: string,
): SlotAvailabilityEvidence => {
  const scope = bookingAvailabilityScope(draft);
  return {
    snapshotId:
      snapshotId?.trim()
      || `runtime:${draft.version}:${slot.dateStart}`,
    ...(scope.serviceId != null ? { serviceId: scope.serviceId } : {}),
    ...(scope.durationMinutes != null
      ? { durationMinutes: scope.durationMinutes }
      : {}),
    ...(scope.excludeMeetingIds != null
      ? { excludeMeetingIds: [...scope.excludeMeetingIds] }
      : {}),
  };
};

/**
 * Derived workflow stage for the checkpointed draft projection. Prefer
 * {@link import("./booking-domain/requirement.js").nextBookingRequirement}.
 */
export const bookingDraftPhase = (draft: BookingDraft): BookingPhase => {
  if (
    (draft.phase === "confirming" && draft.pendingCommand != null)
    || draft.pendingDecision?.kind === "mutation_confirm"
    || draft.pendingCommand != null
  ) {
    return "confirming";
  }
  if (draft.mode === "reschedule") {
    if (draft.rescheduleTarget == null) return "service";
    if (draft.selectedDate == null) return "date";
    if (!draftHasVerifiedSlot(draft)) return "time";
    return "ready";
  }
  if (draft.serviceAcceptance == null || draft.serviceAcceptance.status !== "accepted") {
    return "service";
  }
  if (draft.selectedDate == null) {
    return "date";
  }
  if (!draftHasVerifiedSlot(draft)) {
    return "time";
  }
  if (draft.note.status !== "skipped" && draft.note.status !== "answered") {
    return "note";
  }
  // Stay in details until identity is complete — contactId alone (e.g. link of an
  // incomplete CRM row) must not jump to ready / create HITL.
  if (draft.contactId == null) {
    return "details";
  }
  if (
    draft.contactDetails != null
    && nextMissingContactField(draft.contactDetails) != null
  ) {
    return "details";
  }
  return "ready";
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
  contactDetails: null,
  phoneLookupEvidence: null,
  pendingCommand: null,
  rescheduleTarget: null,
  replacement: null,
  pendingDecision: null,
  slotProvenance: null,
  slotEvidence: null,
  pendingEffect: null,
  offeredChoiceIds: null,
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
  slotProvenance: null,
  slotEvidence: null,
  requestedTime: null,
  note: { status: "unasked" },
  pendingCommand: null,
  pendingDecision: null,
  rescheduleTarget: draft.rescheduleTarget ?? null,
  replacement: null,
});

const slotDate = (slot: SelectedBookingSlot): string => slot.dateStart.slice(0, 10);

const hasCompletedNote = (draft: BookingDraft): boolean =>
  draft.note.status === "skipped" || draft.note.status === "answered";

const openFromNull = (event: BookingEvent): BookingDraft | null => {
  switch (event.type) {
    case "service_selected": {
      const acceptance: ServiceAcceptance = {
        status: event.accepted ? "accepted" : "pending",
        service: event.service,
        ...(event.accepted && event.turn != null ? { acceptedAtTurn: event.turn } : {}),
      };
      const opened: BookingDraft = {
        ...createEmptyBookingDraft(),
        serviceAcceptance: acceptance,
      };
      return { ...opened, phase: bookingDraftPhase(opened), version: 1 };
    }
    case "reschedule_started": {
      const opened: BookingDraft = {
        ...createEmptyBookingDraft(),
        mode: "reschedule",
        phase: event.meeting == null ? "service" : "date",
        rescheduleTarget: event.meeting,
      };
      return { ...opened, version: 1 };
    }
    case "command_prepared": {
      if (event.command.action !== "cancel") {
        return null;
      }
      return {
        ...createEmptyBookingDraft(),
        phase: "confirming",
        pendingCommand: event.command,
        version: 1,
      };
    }
    case "existing_booking_detected": {
      return {
        ...createEmptyBookingDraft(),
        mode: "replace",
        phase: "confirming",
        replacement: {
          meeting: event.meeting,
          status: "offered",
        },
        version: 1,
      };
    }
    default:
      return null;
  }
};

/**
 * The only place where booking-draft transitions are defined. UI/LLM layers emit
 * events; they do not mutate individual booking facts independently.
 * `null` means no active booking session.
 */
export const reduceBookingDraft = (
  current: BookingDraft | null | undefined,
  event: BookingEvent,
): BookingDraft | null => {
  if (current == null) {
    return openFromNull(event);
  }
  const draft = current;

  switch (event.type) {
    case "service_selected": {
      const existing = draft.serviceAcceptance;
      // Re-selecting/reaffirming the same service is not a service change. Keep
      // the date, slot, note, and command so an LLM retry or a patient restating
      // their choice cannot restart the booking ladder.
      if (existing?.service.id === event.service.id) {
        const accepted = existing.status === "accepted" || event.accepted === true;
        // Close an open catalog page even when reaffirming the same CRM id.
        const pendingDecision: BookingDraft["pendingDecision"] =
          draft.pendingDecision?.kind === "service_candidate"
            ? null
            : (draft.pendingDecision ?? null);
        const nextAcceptance: ServiceAcceptance = {
          ...existing,
          status: accepted ? "accepted" : existing.status,
          service: { ...existing.service, ...event.service },
          ...(accepted && event.turn != null ? { acceptedAtTurn: event.turn } : {}),
        };
        return withVersion(draft, {
          ...draft,
          serviceAcceptance: nextAcceptance,
          pendingDecision,
          phase: bookingDraftPhase({
            ...draft,
            serviceAcceptance: nextAcceptance,
            pendingDecision,
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
        slotProvenance: null,
        slotEvidence: null,
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
        slotProvenance: null,
        slotEvidence: null,
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
      const note = draft.mode === "reschedule" || hasCompletedNote(draft)
        ? draft.note
        : { status: "awaiting" as const };
      const slotEvidence = slotEvidenceForSelection(
        draft,
        event.slot,
        event.snapshotId,
      );
      const next: Omit<BookingDraft, "version"> = {
        ...draft,
        selectedDate: slotDate(event.slot),
        selectedSlot: event.slot,
        slotProvenance: "availability_tool",
        slotEvidence,
        requestedTime: null,
        note,
        pendingCommand: null,
        pendingDecision:
          draft.pendingDecision?.kind === "mutation_confirm"
            ? null
            : (draft.pendingDecision ?? null),
      };
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
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
        slotProvenance: null,
        slotEvidence: null,
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
    case "contact_field_submitted": {
      const accepted = event.field === "phoneNumber"
        ? normalizeClinicPhone(event.value)
        : normalizeContactName(event.value);
      if (accepted == null) {
        return draft;
      }
      const next = {
        ...draft,
        contactDetails: {
          ...(draft.contactDetails ?? {}),
          [event.field]: accepted,
        },
        // New phone invalidates prior lookup evidence for a different number.
        ...(event.field === "phoneNumber" ? { phoneLookupEvidence: null } : {}),
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "contact_resolved": {
      const next = {
        ...draft,
        contactId: event.contactId,
        // Keep accepted details across link→update unless CRM is already complete.
        ...(event.clearDetails === true ? { contactDetails: null } : {}),
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "contact_details_cleared": {
      const next = {
        ...draft,
        contactDetails: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "phone_lookup_recorded":
      return withVersion(draft, {
        ...draft,
        phoneLookupEvidence: event.evidence,
      });
    case "contact_unresolved": {
      const next = {
        ...draft,
        contactId: null,
        pendingCommand: null,
        ...(draft.mode === "reschedule"
          ? {
              rescheduleTarget: null,
              selectedDate: null,
              selectedSlot: null,
              requestedTime: null,
            }
          : {}),
      };
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
        slotProvenance: null,
        slotEvidence: null,
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
      if (event.command.action === "create" || event.command.action === "reschedule") {
        const expectedDuration = bookingVisitDurationMinutes(draft);
        const payloadDuration = visitSpanMinutes(
          typeof payload.dateStart === "string" ? payload.dateStart : null,
          typeof payload.dateEnd === "string" ? payload.dateEnd : null,
        );
        if (
          expectedDuration != null
          && payloadDuration != null
          && payloadDuration !== expectedDuration
        ) {
          return draft;
        }
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
    case "cancel_existing_completed": {
      // Pre-slot REPLACE (graph offered before create_meeting) has no frozen
      // originalCommand — clear replacement and continue a normal create draft.
      const original = draft.replacement?.originalCommand;
      if (original == null || (original.action !== "create" && original.action !== "reschedule")) {
        const cleared = {
          ...draft,
          mode: "create" as const,
          pendingCommand: null,
          replacement: null,
        };
        return withVersion(draft, {
          ...cleared,
          phase: bookingDraftPhase(cleared),
        });
      }
      return withVersion(draft, {
        ...draft,
        mode: "create",
        phase: "confirming",
        pendingCommand: null,
        replacement: draft.replacement
          ? { ...draft.replacement, status: "create_pending" }
          : null,
      });
    }
    case "cancel_existing_declined":
      // The existing appointment is still active; never leave a ready create
      // draft behind or the graph will immediately replay Already booked.
      return null;
    case "slot_invalidated":
      return withVersion(draft, {
        ...draft,
        phase: event.keepDate ? "time" : "date",
        selectedDate: event.keepDate ? draft.selectedDate : null,
        selectedSlot: null,
        slotProvenance: null,
        slotEvidence: null,
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
      return null;
    case "effect_prepared":
      return withVersion(draft, { ...draft, pendingEffect: event.effect });
    case "effect_status": {
      if (draft.pendingEffect == null) {
        return draft;
      }
      return withVersion(draft, {
        ...draft,
        pendingEffect: { ...draft.pendingEffect, status: event.status },
      });
    }
    case "effect_cleared": {
      if (draft.pendingEffect == null) {
        return draft;
      }
      return withVersion(draft, { ...draft, pendingEffect: null });
    }
    case "decision_set": {
      const next = {
        ...draft,
        pendingDecision: event.decision,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "decision_cleared": {
      const next = {
        ...draft,
        pendingDecision: null,
      } satisfies Omit<BookingDraft, "version">;
      return withVersion(draft, {
        ...next,
        phase: bookingDraftPhase({ ...next, version: draft.version }),
      });
    }
    case "slot_provenance_set":
      return withVersion(draft, {
        ...draft,
        slotProvenance: event.provenance,
        slotEvidence:
          event.evidence === undefined ? (draft.slotEvidence ?? null) : event.evidence,
      });
    case "choices_offered":
      return withVersion(draft, {
        ...draft,
        offeredChoiceIds: [...event.choiceIds],
      });
    case "choices_cleared":
      return withVersion(draft, { ...draft, offeredChoiceIds: null });
  }
};

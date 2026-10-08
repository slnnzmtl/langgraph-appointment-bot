import type { SelectedBookingSlot } from "./types.js";
import {
  clearBookingOwnedInteraction,
  openVisitNoteInteraction,
  type PendingInteraction,
} from "./pending-interaction.js";

/** Open visit_note once when a checkpoint already awaits a note after a slot pick. */
const pendingInteractionForUpgradedDraft = (
  draft: BookingDraft | null,
): PendingInteraction | null => {
  if (draft == null || draft.selectedSlot == null || draft.note.status !== "awaiting") {
    return null;
  }
  return openVisitNoteInteraction();
};

export const BOOKING_SCHEMA_VERSION = 1;

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

/** Structured fields read from a version-0 booking checkpoint. */
export type BookingCheckpointLegacyState = {
  bookingSchemaVersion?: number | null;
  bookingDraft?: BookingDraft | null;
  bookingNoteStatus?: BookingNote["status"];
  selectedSlot?: SelectedBookingSlot | null;
  selectedAvailabilityDate?: string | null;
};

export type BookingCheckpointMigrationTelemetry = {
  source: "legacy_draft" | "legacy_projection" | "empty_draft";
  schemaVersion: number;
  outcome: "canonical" | "fail_closed" | "unsupported";
};

export type BookingCheckpointUpgradeResult = {
  update: {
    bookingSchemaVersion?: number;
    bookingDraft?: BookingDraft | null;
    bookingNoteStatus?: "unasked";
    selectedSlot?: null;
    selectedAvailabilityDate?: null;
    pendingInteraction?: PendingInteraction | null;
  };
  unsupported: boolean;
  telemetry: BookingCheckpointMigrationTelemetry | null;
};

const draftHasValidServiceAcceptance = (draft: BookingDraft): boolean => {
  const id = draft.serviceAcceptance?.service?.id;
  return typeof id === "string"
    && id.trim().length > 0
    && (draft.serviceAcceptance?.status === "accepted" || draft.serviceAcceptance?.status === "pending");
};

const trimmedNonblank = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const trimmedServiceId = (draft: BookingDraft): string | null =>
  trimmedNonblank(draft.serviceAcceptance?.service?.id);

const trimmedTargetId = (target: { id?: unknown } | null | undefined): string | null =>
  trimmedNonblank(target?.id);

const hasRescheduleOrReplacementTarget = (draft: BookingDraft): boolean =>
  (draft.mode === "reschedule" && trimmedTargetId(draft.rescheduleTarget) != null)
  || trimmedTargetId(draft.replacement?.meeting) != null;

const hasActiveLegacyProjection = (state: BookingCheckpointLegacyState): boolean =>
  (state.bookingNoteStatus != null && state.bookingNoteStatus !== "unasked")
  || state.selectedSlot != null
  || state.selectedAvailabilityDate != null;

const clearedLegacyProjections = {
  bookingNoteStatus: "unasked" as const,
  selectedSlot: null,
  selectedAvailabilityDate: null,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/** null is allowed; a non-null string must be a real UTC calendar day. */
const isValidSelectedDate = (value: unknown): value is string | null => {
  if (value == null) {
    return true;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return false;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utc = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(utc);
  return roundTrip.getUTCFullYear() === year
    && roundTrip.getUTCMonth() === month - 1
    && roundTrip.getUTCDate() === day;
};

const isValidSlot = (value: unknown): boolean => {
  if (value == null) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  const { dateStart, dateEnd } = value;
  if (typeof dateStart !== "string" || typeof dateEnd !== "string") {
    return false;
  }
  const start = Date.parse(dateStart);
  const end = Date.parse(dateEnd);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
};

const slotRequiresMatchingDate = (draft: BookingDraft): boolean => {
  if (draft.selectedSlot == null) {
    return false;
  }
  if (draft.selectedDate == null) {
    return true;
  }
  return draft.selectedSlot.dateStart.slice(0, 10) !== draft.selectedDate;
};

const hasBlankTargetId = (draft: BookingDraft): boolean => {
  if (draft.rescheduleTarget != null && trimmedTargetId(draft.rescheduleTarget) == null) {
    return true;
  }
  if (draft.replacement != null && trimmedTargetId(draft.replacement.meeting) == null) {
    return true;
  }
  return false;
};

/** Create payload must match canonical service, contact, date, and slot. */
const createPayloadMatchesDraft = (
  draft: BookingDraft,
  payload: Record<string, unknown>,
): boolean => {
  const noteOk = draft.note.status === "skipped" || draft.note.status === "answered";
  const contactId = trimmedNonblank(draft.contactId);
  const serviceId = trimmedServiceId(draft);
  const accepted = draft.serviceAcceptance?.status === "accepted" && serviceId != null;
  const dateOk = draft.selectedDate != null && isValidSelectedDate(draft.selectedDate);
  const slotOk = draft.selectedSlot != null
    && isValidSlot(draft.selectedSlot)
    && !slotRequiresMatchingDate(draft);
  return (draft.mode === "create" || draft.mode === "replace")
    && accepted
    && dateOk
    && slotOk
    && noteOk
    && contactId != null
    && payload.contactId === contactId
    && payload.serviceId === serviceId
    && payload.dateStart === draft.selectedSlot!.dateStart
    && payload.dateEnd === draft.selectedSlot!.dateEnd;
};

/**
 * Pending-command facts required before a mutation can stay executable.
 * Confirming without a command is also a violation.
 */
const hasPendingCommandViolation = (draft: BookingDraft): boolean => {
  if (draft.pendingCommand == null && draft.phase !== "confirming") {
    return false;
  }
  const command = draft.pendingCommand;
  if (command == null || !isPlainObject(command.payload)) {
    return true;
  }
  const payload = command.payload;
  if (command.action === "create") {
    return !createPayloadMatchesDraft(draft, payload);
  }
  if (command.action === "reschedule") {
    const targetId = trimmedTargetId(draft.rescheduleTarget);
    const dateOk = draft.selectedDate != null && isValidSelectedDate(draft.selectedDate);
    const slotOk = draft.selectedSlot != null
      && isValidSlot(draft.selectedSlot)
      && !slotRequiresMatchingDate(draft);
    return !(
      draft.mode === "reschedule"
      && targetId != null
      && dateOk
      && slotOk
      && payload.meetingId === targetId
      && payload.dateStart === draft.selectedSlot!.dateStart
      && payload.dateEnd === draft.selectedSlot!.dateEnd
    );
  }
  if (command.action === "cancel") {
    const meetingId = trimmedNonblank(payload.meetingId);
    if (meetingId == null) {
      return true;
    }
    const replacementId = trimmedTargetId(draft.replacement?.meeting);
    if (draft.replacement != null && replacementId !== meetingId) {
      return true;
    }
    return false;
  }
  return true;
};

/**
 * create_pending is resumed by agent-loop via originalCommand, independent of
 * phase / pendingCommand. Missing or mismatched nested create must fail closed.
 */
const hasCreatePendingCommandViolation = (draft: BookingDraft): boolean => {
  if (draft.replacement?.status !== "create_pending") {
    return false;
  }
  const command = draft.replacement.originalCommand;
  if (command == null || command.action !== "create" || !isPlainObject(command.payload)) {
    return true;
  }
  return !createPayloadMatchesDraft(draft, command.payload);
};

const hasExecutableCommandViolation = (draft: BookingDraft): boolean =>
  hasPendingCommandViolation(draft) || hasCreatePendingCommandViolation(draft);

/** Copy only known BookingDraft keys so unknown legacy fields cannot leak. */
const constructBookingDraft = (fields: {
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
  rescheduleTarget?: ReplacementMeeting | null;
  replacement?: ReplacementState | null;
}): BookingDraft => ({
  version: fields.version,
  mode: fields.mode,
  phase: fields.phase,
  serviceAcceptance: fields.serviceAcceptance,
  selectedDate: fields.selectedDate,
  selectedSlot: fields.selectedSlot,
  requestedTime: fields.requestedTime,
  note: fields.note,
  contactId: fields.contactId,
  pendingCommand: fields.pendingCommand,
  rescheduleTarget: fields.rescheduleTarget ?? null,
  replacement: fields.replacement ?? null,
});

const copyMeeting = (meeting: ReplacementMeeting): ReplacementMeeting => {
  const id = trimmedTargetId(meeting)!;
  return {
    id,
    ...(typeof meeting.name === "string" ? { name: meeting.name } : {}),
    ...(typeof meeting.dateStart === "string" ? { dateStart: meeting.dateStart } : {}),
    ...(typeof meeting.dateEnd === "string" ? { dateEnd: meeting.dateEnd } : {}),
  };
};

const copyPendingCommand = (command: PendingBookingCommand): PendingBookingCommand => ({
  action: command.action,
  payload: { ...command.payload },
});

const copyServiceAcceptance = (
  acceptance: ServiceAcceptance,
  serviceId: string,
): ServiceAcceptance => ({
  status: acceptance.status,
  service: {
    id: serviceId,
    ...(typeof acceptance.service.name === "string" ? { name: acceptance.service.name } : {}),
    ...(typeof acceptance.service.durationMinutes === "number"
      ? { durationMinutes: acceptance.service.durationMinutes }
      : {}),
    source: acceptance.service.source,
  },
  ...(acceptance.acceptedAtTurn != null ? { acceptedAtTurn: acceptance.acceptedAtTurn } : {}),
});

const draftVersion = (draft: BookingDraft): number =>
  typeof draft.version === "number" && Number.isFinite(draft.version) ? draft.version : 0;

/**
 * Readable legacy draft for migration. Missing note or non-object drafts are rejected
 * before empty-draft / phase helpers read nested fields.
 */
const isReadableLegacyDraft = (draft: unknown): draft is BookingDraft => {
  if (!isPlainObject(draft)) {
    return false;
  }
  if (!isPlainObject(draft.note) || typeof draft.note.status !== "string") {
    return false;
  }
  return true;
};

type ResolvedSchemaVersion =
  | { kind: "legacy" }
  | { kind: "current" }
  | { kind: "unsupported"; version: number };

const resolveSchemaVersion = (raw: unknown): ResolvedSchemaVersion => {
  if (raw == null) {
    return { kind: "legacy" };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return {
      kind: "unsupported",
      version: typeof raw === "number" && Number.isFinite(raw) ? raw : Number.NaN,
    };
  }
  if (raw < 0 || raw > BOOKING_SCHEMA_VERSION) {
    return { kind: "unsupported", version: raw };
  }
  if (raw === BOOKING_SCHEMA_VERSION) {
    return { kind: "current" };
  }
  return { kind: "legacy" };
};

const failClosedNull = (stamp: {
  bookingSchemaVersion: number;
  bookingNoteStatus: "unasked";
  selectedSlot: null;
  selectedAvailabilityDate: null;
}, source: BookingCheckpointMigrationTelemetry["source"]): BookingCheckpointUpgradeResult => ({
  update: {
    ...stamp,
    bookingDraft: null,
  },
  unsupported: false,
  telemetry: {
    source,
    schemaVersion: 0,
    outcome: "fail_closed",
  },
});

const failClosedServiceOnly = (
  stamp: {
    bookingSchemaVersion: number;
    bookingNoteStatus: "unasked";
    selectedSlot: null;
    selectedAvailabilityDate: null;
  },
  draft: BookingDraft,
  serviceId: string,
): BookingCheckpointUpgradeResult => {
  const serviceOnly = constructBookingDraft({
    version: draftVersion(draft),
    mode: draft.mode,
    phase: "service",
    serviceAcceptance: copyServiceAcceptance(draft.serviceAcceptance!, serviceId),
    selectedDate: null,
    selectedSlot: null,
    requestedTime: null,
    note: { status: "unasked" },
    contactId: trimmedNonblank(draft.contactId),
    pendingCommand: null,
    rescheduleTarget: null,
    // Never retain a frozen replacement create — agent-loop would replay it.
    replacement: null,
  });
  return {
    update: {
      ...stamp,
      bookingDraft: serviceOnly,
    },
    unsupported: false,
    telemetry: {
      source: "legacy_draft",
      schemaVersion: 0,
      outcome: "fail_closed",
    },
  };
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

/**
 * Upgrade a version-0 booking checkpoint once from structured fields only.
 * Does not read conversation history or invent Consultation from prose.
 */
export const upgradeBookingCheckpoint = (
  state: BookingCheckpointLegacyState,
): BookingCheckpointUpgradeResult => {
  const resolved = resolveSchemaVersion(state.bookingSchemaVersion);
  if (resolved.kind === "current") {
    return { update: {}, unsupported: false, telemetry: null };
  }
  if (resolved.kind === "unsupported") {
    return {
      update: {},
      unsupported: true,
      telemetry: {
        source: "legacy_draft",
        schemaVersion: Number.isFinite(resolved.version) ? resolved.version : 0,
        outcome: "unsupported",
      },
    };
  }

  const rawDraft = state.bookingDraft;
  const projectionsActive = hasActiveLegacyProjection(state);
  const stamp = {
    bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
    ...clearedLegacyProjections,
  };

  if (rawDraft == null) {
    return {
      update: {
        ...stamp,
        bookingDraft: null,
      },
      unsupported: false,
      telemetry: projectionsActive
        ? {
            source: "legacy_projection",
            schemaVersion: 0,
            outcome: "fail_closed",
          }
        : null,
    };
  }

  if (!isReadableLegacyDraft(rawDraft)) {
    return failClosedNull(stamp, "legacy_draft");
  }

  const draft = rawDraft;

  if (isEmptyLegacyBookingDraft(draft)) {
    return {
      update: {
        ...stamp,
        bookingDraft: null,
      },
      unsupported: false,
      telemetry: {
        source: "empty_draft",
        schemaVersion: 0,
        outcome: "canonical",
      },
    };
  }

  const serviceId = trimmedServiceId(draft);
  const hasCorruptService = draft.serviceAcceptance != null && serviceId == null;
  const hasCorruptDateOrSlot = !isValidSelectedDate(draft.selectedDate)
    || !isValidSlot(draft.selectedSlot)
    || slotRequiresMatchingDate(draft);
  const hasCorruptFacts = hasCorruptDateOrSlot
    || hasCorruptService
    || hasBlankTargetId(draft)
    || hasExecutableCommandViolation(draft);

  if (hasCorruptFacts || !draftHasValidServiceAcceptance(draft)) {
    // Reschedule/replacement with a target is kept only when the draft shape is
    // readable and date/slot/service facts are not contradictory.
    if (
      !hasCorruptDateOrSlot
      && !hasCorruptService
      && !hasBlankTargetId(draft)
      && !draftHasValidServiceAcceptance(draft)
      && hasRescheduleOrReplacementTarget(draft)
    ) {
      // Keep the meeting id for an offered replacement, but never a frozen
      // create_pending originalCommand that agent-loop would resume.
      const replacementMeeting = draft.replacement?.meeting;
      const keptReplacement = replacementMeeting != null
        && trimmedTargetId(replacementMeeting) != null
        ? { meeting: copyMeeting(replacementMeeting), status: "offered" as const }
        : null;
      const keptReschedule = draft.mode === "reschedule" && draft.rescheduleTarget != null
        && trimmedTargetId(draft.rescheduleTarget) != null
        ? copyMeeting(draft.rescheduleTarget)
        : null;
      const keptBase = constructBookingDraft({
        version: draftVersion(draft),
        mode: draft.mode,
        phase: "service",
        serviceAcceptance: null,
        selectedDate: isValidSelectedDate(draft.selectedDate) ? draft.selectedDate : null,
        selectedSlot: isValidSlot(draft.selectedSlot) ? draft.selectedSlot : null,
        requestedTime: draft.requestedTime ?? null,
        note: draft.note,
        contactId: trimmedNonblank(draft.contactId),
        pendingCommand: null,
        rescheduleTarget: keptReschedule,
        replacement: keptReplacement,
      });
      const kept = constructBookingDraft({
        ...keptBase,
        phase: bookingDraftPhase(keptBase),
      });
      return {
        update: {
          ...stamp,
          bookingDraft: kept,
          pendingInteraction: pendingInteractionForUpgradedDraft(kept),
        },
        unsupported: false,
        telemetry: {
          source: "legacy_draft",
          schemaVersion: 0,
          outcome: "canonical",
        },
      };
    }
    if (serviceId != null && draft.serviceAcceptance != null) {
      return failClosedServiceOnly(stamp, draft, serviceId);
    }
    return failClosedNull(
      stamp,
      projectionsActive && draft.selectedDate == null && draft.selectedSlot == null
        ? "legacy_projection"
        : "legacy_draft",
    );
  }

  const pendingCommand = draft.pendingCommand != null
    ? copyPendingCommand(draft.pendingCommand)
    : null;
  let replacement: ReplacementState | null = null;
  if (draft.replacement != null && trimmedTargetId(draft.replacement.meeting) != null) {
    const status = draft.replacement.status;
    replacement = {
      meeting: copyMeeting(draft.replacement.meeting),
      status,
      ...(
        status === "create_pending" && draft.replacement.originalCommand != null
          ? { originalCommand: copyPendingCommand(draft.replacement.originalCommand) }
          : {}
      ),
    };
  }
  const rescheduleTarget = draft.rescheduleTarget != null
    && trimmedTargetId(draft.rescheduleTarget) != null
    ? copyMeeting(draft.rescheduleTarget)
    : null;
  const withCommands = constructBookingDraft({
    version: draftVersion(draft),
    mode: draft.mode,
    phase: pendingCommand != null ? "confirming" : draft.phase,
    serviceAcceptance: draft.serviceAcceptance != null && serviceId != null
      ? copyServiceAcceptance(draft.serviceAcceptance, serviceId)
      : null,
    selectedDate: draft.selectedDate,
    selectedSlot: draft.selectedSlot,
    requestedTime: draft.requestedTime ?? null,
    note: draft.note,
    contactId: trimmedNonblank(draft.contactId),
    pendingCommand,
    rescheduleTarget,
    replacement,
  });
  const canonical = constructBookingDraft({
    ...withCommands,
    phase: bookingDraftPhase(withCommands),
  });
  return {
    update: {
      ...stamp,
      bookingDraft: canonical,
      pendingInteraction: pendingInteractionForUpgradedDraft(canonical),
    },
    unsupported: false,
    telemetry: {
      source: "legacy_draft",
      schemaVersion: 0,
      outcome: "canonical",
    },
  };
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

/** Atomically close a booking session, including deprecated checkpoint projections. */
export const closedBookingSessionUpdate = (
  pendingInteraction?: PendingInteraction | null,
): {
  bookingDraft: null;
  bookingNoteStatus: "unasked";
  selectedSlot: null;
  selectedAvailabilityDate: null;
  pendingInteraction: PendingInteraction | null;
  serviceChangeNotice: null;
} => ({
  bookingDraft: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
  selectedAvailabilityDate: null,
  pendingInteraction: clearBookingOwnedInteraction(pendingInteraction),
  serviceChangeNotice: null,
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
      const note = draft.mode === "reschedule" || hasCompletedNote(draft)
        ? draft.note
        : { status: "awaiting" as const };
      const next = {
        ...draft,
        selectedDate: slotDate(event.slot),
        selectedSlot: event.slot,
        requestedTime: null,
        note,
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
      return null;
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
      return null;
  }
};

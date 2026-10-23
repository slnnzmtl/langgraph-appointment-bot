import {
  BOOKING_SCHEMA_VERSION,
  bookingDraftPhase,
  effectiveBookingContactDetails,
  isEmptyLegacyBookingDraft,
  type BookingContactDetails,
  type BookingDraft,
  type BookingMode,
  type BookingNote,
  type BookingPhase,
  type PendingBookingCommand,
  type PhoneLookupEvidence,
  type ReplacementMeeting,
  type ReplacementState,
  type RequestedBookingTime,
  type ServiceAcceptance,
} from "./booking-draft.js";
import type { SelectedBookingSlot } from "./types.js";

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
    /** Set by booking-session when composing the checkpoint upgrade. */
    pendingInteraction?: unknown;
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

/** Migration boundary only — do not use in live graph routing or nodes. */
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

const BOOKING_MODES = new Set(["create", "reschedule", "replace"]);
const BOOKING_PHASES = new Set([
  "service",
  "date",
  "time",
  "note",
  "details",
  "ready",
  "confirming",
]);
const NOTE_STATUSES = new Set(["unasked", "awaiting", "skipped", "answered"]);
const SERVICE_SOURCES = new Set(["catalog", "direct", "crm"]);
const SERVICE_ACCEPTANCE_STATUSES = new Set(["pending", "accepted"]);
const REPLACEMENT_STATUSES = new Set(["offered", "cancelling", "create_pending"]);
const REQUESTED_TIME_STATUSES = new Set(["pending", "unavailable"]);
/** Runtime command actions — "replace" is a booking mode, not a command. */
const PENDING_COMMAND_ACTIONS = new Set(["create", "reschedule", "cancel"]);

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";

const isOptionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

const isValidMeeting = (value: unknown): boolean => {
  if (!isPlainObject(value)) {
    return false;
  }
  if (trimmedNonblank(value.id) == null) {
    return false;
  }
  return isOptionalString(value.name)
    && isOptionalString(value.dateStart)
    && isOptionalString(value.dateEnd);
};

const isValidPendingCommand = (value: unknown): boolean => {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.action !== "string" || !PENDING_COMMAND_ACTIONS.has(value.action)) {
    return false;
  }
  return isPlainObject(value.payload);
};

const isValidSlot = (value: unknown): boolean => {
  if (value == null) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  const { dateStart, dateEnd, label, slotId } = value;
  if (typeof dateStart !== "string" || typeof dateEnd !== "string") {
    return false;
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    return false;
  }
  if (slotId !== undefined && (typeof slotId !== "string" || slotId.trim().length === 0)) {
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

/**
 * Create payload must match canonical service, contact, date, and slot.
 * Accepts tool-arg shape (`contactId` / `serviceId`) and CRM write shape
 * (`parentId` / `contactsIds` / `cServicesIds`) frozen on HITL.
 */
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
  if (
    !(draft.mode === "create" || draft.mode === "replace")
    || !accepted
    || !dateOk
    || !slotOk
    || !noteOk
    || contactId == null
    || serviceId == null
  ) {
    return false;
  }
  if (
    payload.dateStart !== draft.selectedSlot!.dateStart
    || payload.dateEnd !== draft.selectedSlot!.dateEnd
  ) {
    return false;
  }
  // Tool-arg shape (kernel effect / legacy checkpoints).
  if (payload.contactId === contactId && payload.serviceId === serviceId) {
    return true;
  }
  // CRM write shape (interrupt / frozenCommand).
  const contactsIds = Array.isArray(payload.contactsIds) ? payload.contactsIds : [];
  const cServicesIds = Array.isArray(payload.cServicesIds) ? payload.cServicesIds : [];
  return payload.parentId === contactId
    && contactsIds.length === 1
    && contactsIds[0] === contactId
    && cServicesIds.length === 1
    && cServicesIds[0] === serviceId;
};

/**
 * Pending-command facts required before a mutation can stay executable.
 * Confirming without a command is also a violation.
 */
const hasPendingCommandViolation = (draft: BookingDraft): boolean => {
  if (draft.pendingCommand == null && draft.phase !== "confirming") {
    return false;
  }
  // Offered REPLACE waits on visit_select, not a mutation pendingCommand.
  if (
    draft.pendingCommand == null
    && draft.replacement?.status === "offered"
  ) {
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
 * Frozen replacement create is resumed by agent-loop via originalCommand.
 * create_pending requires a matching nested create. offered / cancelling may
 * omit originalCommand (pre-slot REPLACE); a present create must still match
 * canonical service, contact, and slot facts.
 */
const hasPreservedCreateCommandViolation = (draft: BookingDraft): boolean => {
  const command = draft.replacement?.originalCommand;
  if (draft.replacement?.status === "create_pending") {
    if (command == null || command.action !== "create" || !isPlainObject(command.payload)) {
      return true;
    }
    return !createPayloadMatchesDraft(draft, command.payload);
  }
  if (command == null || command.action !== "create") {
    return false;
  }
  return !isPlainObject(command.payload) || !createPayloadMatchesDraft(draft, command.payload);
};

const hasExecutableCommandViolation = (draft: BookingDraft): boolean =>
  hasPendingCommandViolation(draft) || hasPreservedCreateCommandViolation(draft);

const copyContactDetails = (
  details: BookingContactDetails | null | undefined,
): BookingContactDetails | null => {
  const copied = effectiveBookingContactDetails({ contactDetails: details ?? null });
  return Object.keys(copied).length > 0 ? copied : null;
};

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
  contactDetails?: BookingContactDetails | null;
  phoneLookupEvidence?: PhoneLookupEvidence | null;
  pendingCommand: PendingBookingCommand | null;
  rescheduleTarget?: ReplacementMeeting | null;
  replacement?: ReplacementState | null;
}): BookingDraft => ({
  version: fields.version,
  mode: fields.mode,
  phase: fields.phase,
  serviceAcceptance: fields.serviceAcceptance ?? null,
  selectedDate: fields.selectedDate ?? null,
  selectedSlot: fields.selectedSlot ?? null,
  requestedTime: fields.requestedTime ?? null,
  note: fields.note,
  contactId: fields.contactId ?? null,
  contactDetails: copyContactDetails(fields.contactDetails),
  phoneLookupEvidence: fields.phoneLookupEvidence ?? null,
  pendingCommand: fields.pendingCommand ?? null,
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
 * Readable legacy draft for migration. Unknown discriminants or incomplete nested
 * shapes are rejected before empty-draft / phase helpers trust nested fields.
 */
const isReadableLegacyDraft = (draft: unknown): draft is BookingDraft => {
  if (!isPlainObject(draft)) {
    return false;
  }
  if (typeof draft.mode !== "string" || !BOOKING_MODES.has(draft.mode)) {
    return false;
  }
  if (typeof draft.phase !== "string" || !BOOKING_PHASES.has(draft.phase)) {
    return false;
  }
  if (!isPlainObject(draft.note)) {
    return false;
  }
  if (typeof draft.note.status !== "string" || !NOTE_STATUSES.has(draft.note.status)) {
    return false;
  }
  if (draft.note.value !== undefined && typeof draft.note.value !== "string") {
    return false;
  }
  if (draft.serviceAcceptance != null) {
    if (!isPlainObject(draft.serviceAcceptance)) {
      return false;
    }
    const acceptance = draft.serviceAcceptance;
    if (
      typeof acceptance.status !== "string"
      || !SERVICE_ACCEPTANCE_STATUSES.has(acceptance.status)
    ) {
      return false;
    }
    if (!isPlainObject(acceptance.service)) {
      return false;
    }
    const service = acceptance.service;
    if (trimmedNonblank(service.id) == null) {
      return false;
    }
    if (typeof service.source !== "string" || !SERVICE_SOURCES.has(service.source)) {
      return false;
    }
    if (!isOptionalString(service.name) || !isOptionalFiniteNumber(service.durationMinutes)) {
      return false;
    }
    if (!isOptionalFiniteNumber(acceptance.acceptedAtTurn)) {
      return false;
    }
  }
  if (draft.selectedDate !== undefined && !isValidSelectedDate(draft.selectedDate)) {
    return false;
  }
  if (draft.selectedSlot !== undefined && !isValidSlot(draft.selectedSlot)) {
    return false;
  }
  if (draft.requestedTime != null) {
    if (!isPlainObject(draft.requestedTime)) {
      return false;
    }
    if (trimmedNonblank(draft.requestedTime.value) == null) {
      return false;
    }
    if (
      typeof draft.requestedTime.status !== "string"
      || !REQUESTED_TIME_STATUSES.has(draft.requestedTime.status)
    ) {
      return false;
    }
  }
  if (draft.pendingCommand != null && !isValidPendingCommand(draft.pendingCommand)) {
    return false;
  }
  if (draft.rescheduleTarget != null && !isValidMeeting(draft.rescheduleTarget)) {
    return false;
  }
  if (draft.replacement != null) {
    if (!isPlainObject(draft.replacement)) {
      return false;
    }
    const replacement = draft.replacement;
    if (
      typeof replacement.status !== "string"
      || !REPLACEMENT_STATUSES.has(replacement.status)
    ) {
      return false;
    }
    if (!isValidMeeting(replacement.meeting)) {
      return false;
    }
    if (
      replacement.originalCommand != null
      && !isValidPendingCommand(replacement.originalCommand)
    ) {
      return false;
    }
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
 * Upgrade a version-0 booking checkpoint once from structured fields only.
 * Does not open visit_note UI — booking-session composes that after the draft
 * upgrade. Does not read conversation history or invent Consultation from prose.
 */
export const upgradeBookingDraftCheckpoint = (
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
        selectedDate: isValidSelectedDate(draft.selectedDate) ? draft.selectedDate ?? null : null,
        selectedSlot: isValidSlot(draft.selectedSlot) ? draft.selectedSlot ?? null : null,
        requestedTime: draft.requestedTime ?? null,
        note: draft.note,
        contactId: trimmedNonblank(draft.contactId),
        contactDetails: draft.contactDetails ?? null,
        pendingCommand: null,
        rescheduleTarget: keptReschedule,
        replacement: keptReplacement,
      });
      const kept = { ...keptBase, phase: bookingDraftPhase(keptBase) };
      return {
        update: {
          ...stamp,
          bookingDraft: kept,
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
        draft.replacement.originalCommand != null
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
    selectedDate: draft.selectedDate ?? null,
    selectedSlot: draft.selectedSlot ?? null,
    requestedTime: draft.requestedTime ?? null,
    note: draft.note,
    contactId: trimmedNonblank(draft.contactId),
    contactDetails: draft.contactDetails ?? null,
    pendingCommand,
    rescheduleTarget,
    replacement,
  });
  const canonical = { ...withCommands, phase: bookingDraftPhase(withCommands) };
  return {
    update: {
      ...stamp,
      bookingDraft: canonical,
    },
    unsupported: false,
    telemetry: {
      source: "legacy_draft",
      schemaVersion: 0,
      outcome: "canonical",
    },
  };
};

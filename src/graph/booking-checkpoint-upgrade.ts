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
  serviceAcceptance: fields.serviceAcceptance,
  selectedDate: fields.selectedDate,
  selectedSlot: fields.selectedSlot,
  requestedTime: fields.requestedTime,
  note: fields.note,
  contactId: fields.contactId,
  contactDetails: copyContactDetails(fields.contactDetails),
  phoneLookupEvidence: fields.phoneLookupEvidence ?? null,
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
        selectedDate: isValidSelectedDate(draft.selectedDate) ? draft.selectedDate : null,
        selectedSlot: isValidSlot(draft.selectedSlot) ? draft.selectedSlot : null,
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

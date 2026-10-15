import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BOOKING_AGENT_ID } from "../types.js";
import {
  normalizePresentAvailabilityResult,
  type AvailabilityContext,
} from "../../tools/availability-tools.js";
import { normalizeListServicesResult, type ServicesContext } from "../../tools/service-tools.js";
import { BOOKING_CONTACT_REQUIRED_FIELDS } from "../../tools/contact-tools.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { asJsonRecord, committedMeetingEntityId, jsonEntityId } from "../../shared/json-record.js";
import {
  extractMessageTextContent,
  extractRawMessageText,
} from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import type { ClinicState } from "../state.js";
import { type ReplacementMeeting } from "../booking-draft.js";

/** CRM writes that invalidate checkpointed contact/meetings prefetch. */
const PREFETCH_INVALIDATING_TOOLS = new Set([
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

export const MEETING_MUTATION_TOOLS = new Set([
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

export const meetingMutationUnauthorizedThisTurn = (
  messages: BaseMessage[],
): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage) || !MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
      return false;
    }
    return asJsonRecord(extractMessageTextContent(message.content).trim())?.error
      === "Not authorized";
  });

/** Contact CRM writes that must not same-turn retry after known_field / operational failure. */
export const CONTACT_WRITE_TOOLS = new Set([
  "create_contact",
  "update_contact",
  "link_telegram_to_contact",
]);

export type ContactWriteOutcome = "success" | "known_field" | "operational" | null;

export type ContactWriteClassification = {
  outcome: ContactWriteOutcome;
  tool: string;
  /** Present for known_field when the synthetic error names a specific identity field. */
  field?: "phoneNumber" | "firstName" | "lastName";
  /** Structured synthetic error constant when outcome is known_field. */
  error?: string;
  category?: "known_field" | "operational";
};

export const CREATE_CONSULTATION_REQUIRED_ERROR = "Consultation agreement required";

export const SLOT_SELECTION_REQUIRED_ERROR = "Availability slot selection required";

export const SELECTED_SLOT_NOT_AVAILABLE_ERROR = "Selected slot is no longer available";

export const RESCHEDULE_STATE_REQUIRED_ERROR = "Reschedule state required";

export const CONTACT_OWNERSHIP_REQUIRED_ERROR = "Contact ownership required";

export const CONTACT_LINK_CANDIDATE_REQUIRED_ERROR = "Contact link candidate required";

const CONSULTATION_AGREEMENT_TOOLS = new Set(["create_meeting", "reschedule_meeting"]);

const toolCallServiceId = (call: { args?: unknown }): string | null => {
  const args = call.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const serviceId = (args as { serviceId?: unknown }).serviceId;
  return typeof serviceId === "string" ? serviceId : null;
};

export const blocksConsultationWithoutAgreement = (
  agentId: string | undefined,
  call: { name: string; args?: unknown },
  state: ClinicState,
): boolean =>
  agentId === BOOKING_AGENT_ID
  && CONSULTATION_AGREEMENT_TOOLS.has(call.name)
  && toolCallServiceId(call) === CONSULTATION_SERVICE_ID
  && !(
    state.bookingDraft?.serviceAcceptance?.status === "accepted"
    && state.bookingDraft.serviceAcceptance.service.id === CONSULTATION_SERVICE_ID
  );

/** Real CRM / tool-level outcomes only — invariant guards are typed route outcomes. */
const BLOCKED_MEETING_ERRORS = new Set([
  "Contact incomplete",
  "Already booked",
  "Not authorized",
]);

/** Mutation success is runtime-owned; model prose can never prove a CRM write. */
export type MeetingMutationOutcome =
  | "committed"
  | "pending_confirmation"
  | "declined"
  | "abandoned"
  | "blocked"
  | "failed"
  | null;

export const classifyMeetingMutationToolMessage = (
  message: ToolMessage,
): MeetingMutationOutcome => {
  const name = message.name;
  if (!name || !MEETING_MUTATION_TOOLS.has(name)) {
    return null;
  }
  const body = extractMessageTextContent(message.content).trim();
  if (body.startsWith("Error:")) {
    return "failed";
  }
  const record = asJsonRecord(body);
  if (!record) {
    return "failed";
  }
  if (record.awaitingConfirmation === true) {
    return "pending_confirmation";
  }
  // Main-menu leave: cancelled write with an explicit left flag.
  if (record.left === true && record.cancelled === true) {
    return "abandoned";
  }
  if (record.cancelled === true) {
    return "declined";
  }
  if (typeof record.error === "string") {
    return BLOCKED_MEETING_ERRORS.has(record.error) ? "blocked" : "failed";
  }
  return committedMeetingEntityId(body) != null ? "committed" : "failed";
};

/** True when any meeting mutation tool committed on this turn's tape. */
export const mutationCommittedThisTurn = (messages: BaseMessage[]): boolean =>
  messages.some(
    (message) =>
      message instanceof ToolMessage
      && MEETING_MUTATION_TOOLS.has(message.name ?? "")
      && classifyMeetingMutationToolMessage(message) === "committed",
  );

/** HITL ❌ only — main-menu leave is `abandoned` and must not keep the draft for re-pick. */
export const meetingMutationIsHitlDecline = (message: ToolMessage): boolean =>
  classifyMeetingMutationToolMessage(message) === "declined";

export const terminalMeetingMutationOutcome = (state: ClinicState): ToolMessage | null => {
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof ToolMessage) || !MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
      continue;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    if (message.name !== "cancel_meeting") {
      const record = asJsonRecord(extractMessageTextContent(message.content).trim());
      const isReplacementConflict = record?.error === "Already booked";
      // Contact incomplete is typed ContactCommand recovery via command_prepare.
      const isContactIncomplete = record?.error === "Contact incomplete";
      // Not authorized is finalize-owned patient-safe copy (mutation_finalize).
      const isNotAuthorized = record?.error === "Not authorized";
      if (
        !isReplacementConflict
        && !isContactIncomplete
        && (
          outcome === "committed"
          || outcome === "declined"
          || outcome === "abandoned"
          || outcome === "failed"
          || (outcome === "blocked" && isNotAuthorized)
        )
      ) {
        return message;
      }
      continue;
    }
    // A committed replacement cancellation is a continuation, not a
    // patient-facing terminal outcome: the replacement create flow owns it.
    // Declined/failed/abandoned replacement cancellation outcomes are terminal,
    // but must retain their replacement origin for the correct response/menu.
    if (state.pendingCancellationPurpose === "replacement") {
      // Failed/blocked/abandoned replacement cancel must close the session —
      // leaving cancelling + originalCommand would replay a stale create later.
      return outcome === "declined"
        || outcome === "abandoned"
        || outcome === "failed"
        || outcome === "blocked"
        ? message
        : null;
    }
    // Keep the legacy state guard for checkpoints created before the explicit
    // cancellation-purpose field existed.
    if (state.bookingDraft?.replacement != null) {
      return null;
    }
    if (
      outcome === "committed"
      || outcome === "declined"
      || outcome === "abandoned"
      || outcome === "blocked"
      || outcome === "failed"
    ) {
      return message;
    }
    return null;
  }
  return null;
};

/** Committed, failed, HITL ❌, or main-menu leave — stale free/busy must not survive. */
export const meetingMutationClearsAvailability = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    return (
      outcome === "committed"
      || outcome === "failed"
      || outcome === "declined"
      || outcome === "abandoned"
    );
  });

const toolMessageName = (message: BaseMessage): string | undefined => {
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
};


const latestMeetingMutationJson = (
  messages: BaseMessage[],
  options?: { includeLinkTool?: boolean },
): Record<string, unknown> | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage)) {
      continue;
    }
    const name = message.name ?? "";
    const isMeeting = MEETING_MUTATION_TOOLS.has(name);
    const isLink = name === "link_telegram_to_contact";
    if (!isMeeting && !(options?.includeLinkTool === true && isLink)) {
      continue;
    }
    return asJsonRecord(extractMessageTextContent(message.content).trim()) ?? {};
  }
  return null;
};

/** Latest structured error from a meeting mutation or link tool this turn. */
export const latestMeetingMutationError = (messages: BaseMessage[]): string | undefined => {
  const record = latestMeetingMutationJson(messages, { includeLinkTool: true });
  return typeof record?.error === "string" ? record.error : undefined;
};

export type ContactIncompleteField = (typeof BOOKING_CONTACT_REQUIRED_FIELDS)[number];

/**
 * When the latest meeting-mutation error is Contact incomplete, return CRM
 * missingFields from that ToolMessage (not the cached contactContext).
 * Meeting tools only — link_telegram_to_contact is ignored.
 */
export const latestContactIncompleteMissingFields = (
  messages: BaseMessage[],
): ContactIncompleteField[] | null => {
  const record = latestMeetingMutationJson(messages);
  if (record == null || record.error !== "Contact incomplete") {
    return null;
  }
  const raw = Array.isArray(record.missingFields) ? record.missingFields : [];
  const allowed = new Set<string>(BOOKING_CONTACT_REQUIRED_FIELDS);
  return raw.filter(
    (field): field is ContactIncompleteField =>
      typeof field === "string" && allowed.has(field),
  );
};

/** True when a ToolMessage for this tool is already in the current agent turn. */
export const toolRanThisTurn = (messages: BaseMessage[], toolName: string): boolean =>
  messages.some(
    (message) => message instanceof ToolMessage && toolMessageName(message) === toolName,
  );

/** Index of the latest pending_confirmation mutation ToolMessage, or -1. */
const latestPendingConfirmationIndex = (messages: BaseMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "pending_confirmation"
    ) {
      return index;
    }
  }
  return -1;
};

/**
 * True when present_availability_slots ran after the latest awaitingConfirmation
 * mutation (or anywhere on the tape when there is no pending confirmation).
 * Pre-HITL leftover slots must not block coerce or TIME overlay.
 */
export const availabilitySlotsRanThisTurn = (messages: BaseMessage[]): boolean => {
  const start = latestPendingConfirmationIndex(messages) + 1;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message instanceof ToolMessage
      && toolMessageName(message) === "present_availability_slots"
    ) {
      return true;
    }
  }
  return false;
};

export const captureLatestToolContext = <T>(
  messages: BaseMessage[],
  toolName: string,
  normalize: (raw: string) => T | null,
): T | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || toolMessageName(message) !== toolName) {
      continue;
    }
    return normalize(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
};

export const captureAvailabilityFromMessages = (
  messages: BaseMessage[],
): AvailabilityContext | null | undefined =>
  captureLatestToolContext(messages, "present_availability_slots", normalizePresentAvailabilityResult);

export const captureServicesFromMessages = (
  messages: BaseMessage[],
): ServicesContext | null | undefined =>
  captureLatestToolContext(messages, "list_services", normalizeListServicesResult);


const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

export const lastPatientText = (state: ClinicState): string =>
  lastHumanText(state.messages) || lastHumanText(state.agentMessages ?? []);

export const bookingDateAnchors = (state: ClinicState): string[] => [
  ...(state.bookingDraft?.selectedDate ? [state.bookingDraft.selectedDate] : []),
  ...(state.bookingDraft?.selectedSlot
    ? [state.bookingDraft.selectedSlot.dateStart, state.bookingDraft.selectedSlot.dateEnd]
    : []),
  ...(state.availabilityContext?.days ?? []).map((day) => day.date),
  ...(state.availabilityCursor
    ? [
      state.availabilityCursor.firstDate,
      state.availabilityCursor.lastDate,
      state.availabilityCursor.query?.rangeFrom,
      state.availabilityCursor.query?.rangeThrough,
    ].filter((date): date is string => date != null)
    : []),
];


export const PHONE_GROUNDED_TOOLS = new Set([
  "find_contact_by_phone",
  "create_contact",
  "update_contact",
]);

export const PHONE_NOT_PROVIDED_ERROR = "Phone not provided";

export const NAME_NOT_PROVIDED_ERROR = "Name not provided";

const KNOWN_CONTACT_FIELD_ERRORS = new Set([
  PHONE_NOT_PROVIDED_ERROR,
  NAME_NOT_PROVIDED_ERROR,
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
]);

const contactWriteFieldFromRecord = (
  record: Record<string, unknown>,
  error: string,
): ContactWriteClassification["field"] => {
  const raw = record.field;
  if (raw === "phoneNumber" || raw === "firstName" || raw === "lastName") {
    return raw;
  }
  if (error === PHONE_NOT_PROVIDED_ERROR || error === CONTACT_LINK_CANDIDATE_REQUIRED_ERROR) {
    return "phoneNumber";
  }
  return undefined;
};

/**
 * Classify create_contact / update_contact / link_telegram_to_contact results.
 * Never branches on free-form Espo text — only structured error constants or missing entity id.
 */
export const classifyContactWriteToolMessage = (
  message: ToolMessage,
): ContactWriteClassification | null => {
  const name = message.name;
  if (!name || !CONTACT_WRITE_TOOLS.has(name)) {
    return null;
  }
  const body = extractMessageTextContent(message.content).trim();
  if (body.startsWith("Error:")) {
    return { outcome: "operational", tool: name, category: "operational" };
  }
  const record = asJsonRecord(body);
  if (!record) {
    return { outcome: "operational", tool: name, category: "operational" };
  }
  if (typeof record.error === "string") {
    if (KNOWN_CONTACT_FIELD_ERRORS.has(record.error)) {
      const field = contactWriteFieldFromRecord(record, record.error);
      return {
        outcome: "known_field",
        tool: name,
        category: "known_field",
        error: record.error,
        ...(field != null ? { field } : {}),
      };
    }
    return { outcome: "operational", tool: name, category: "operational" };
  }
  if (jsonEntityId(body) != null) {
    return { outcome: "success", tool: name };
  }
  // Malformed "success" without an entity id is operational, not projected.
  return { outcome: "operational", tool: name, category: "operational" };
};

/**
 * Newest contact-write result this turn when it is known_field or operational.
 * A later success supersedes an earlier failure in the same tape.
 */
export const terminalContactWriteOutcome = (
  state: ClinicState,
): { message: ToolMessage; classification: ContactWriteClassification } | null => {
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof ToolMessage) || !CONTACT_WRITE_TOOLS.has(message.name ?? "")) {
      continue;
    }
    const classification = classifyContactWriteToolMessage(message);
    if (classification == null) {
      continue;
    }
    if (classification.outcome === "success") {
      return null;
    }
    if (classification.outcome === "known_field" || classification.outcome === "operational") {
      return { message, classification };
    }
  }
  return null;
};

/**
 * find_contact_by_phone returned a structured error (does not throw). Terminal
 * for this turn so command_prepare cannot lookup-loop; next patient turn retries.
 */
export const phoneLookupFailedThisTurn = (state: ClinicState): boolean => {
  const messages = state.agentMessages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "find_contact_by_phone") {
      continue;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return true;
    }
    const record = asJsonRecord(body);
    return typeof record?.error === "string" && record.error.length > 0;
  }
  return false;
};

/** True when some HumanMessage in `messages` normalizes to the same E.164 as `wanted`. */
export const humanProvidedPhone = (messages: BaseMessage[], wanted: string): boolean =>
  messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    return normalizeClinicPhone(extractMessageTextContent(message.content)) === wanted;
  });

/**
 * Compare-only name fold for DDD-59 grounding (DDD-206).
 * Trims, lowercases, and maps documented apostrophe glyphs to ASCII `'`.
 * Does not rewrite values stored on collected or forwarded to CRM.
 */
export const normalizeNameForMatch = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    // U+0027 apostrophe, U+2019 right single quotation, U+2018 left single quotation, U+02BC modifier letter apostrophe
    .replace(/['’‘ʼ]/g, "'");

/**
 * True when some HumanMessage equals `wanted` (normalizeNameForMatch), or is two whitespace
 * tokens and `wanted` equals token 0 or 1 (DDD-59 name grounding).
 */
export const humanProvidedName = (messages: BaseMessage[], wanted: string): boolean => {
  const target = normalizeNameForMatch(wanted);
  if (target.length === 0) {
    return false;
  }
  return messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    const text = normalizeNameForMatch(extractMessageTextContent(message.content));
    if (text === target) {
      return true;
    }
    const parts = text.split(/\s+/).filter((part) => part.length > 0);
    return parts.length === 2 && (parts[0] === target || parts[1] === target);
  });
};

export const crmWriteDirtiesPrefetch = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const name = message.name;
    if (!name || !PREFETCH_INVALIDATING_TOOLS.has(name)) {
      return false;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return false;
    }
    const record = asJsonRecord(body);
    if (!record) {
      return true;
    }
    if (typeof record.error === "string") {
      return name === "cancel_meeting";
    }
    return record.cancelled !== true && record.awaitingConfirmation !== true;
  });

/** Latest this-turn create_meeting JSON `error`, or undefined. */
export const latestCreateMeetingError = (messages: BaseMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return undefined;
    }
    const record = asJsonRecord(body);
    return typeof record?.error === "string" ? record.error : undefined;
  }
  return undefined;
};

export const createMeetingAlreadyBooked = (messages: BaseMessage[]): boolean =>
  latestCreateMeetingError(messages) === "Already booked";

export const alreadyBookedMeetingFromMessages = (
  messages: BaseMessage[],
): ReplacementMeeting | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const record = asJsonRecord(extractMessageTextContent(message.content).trim());
    if (record?.error !== "Already booked" || !Array.isArray(record.meetings)) {
      return null;
    }
    const meeting = asJsonRecord(record.meetings[0]);
    if (!meeting || typeof meeting.id !== "string" || meeting.id.length === 0) {
      return null;
    }
    return {
      id: meeting.id,
      ...(typeof meeting.name === "string" ? { name: meeting.name } : {}),
      ...(typeof meeting.dateStart === "string" ? { dateStart: meeting.dateStart } : {}),
      ...(typeof meeting.dateEnd === "string" ? { dateEnd: meeting.dateEnd } : {}),
    };
  }
  return null;
};


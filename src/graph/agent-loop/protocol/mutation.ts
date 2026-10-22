import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { BOOKING_CONTACT_REQUIRED_FIELDS } from "../../../tools/contact-tools.js";
import { asJsonRecord, committedMeetingEntityId } from "../../../shared/json-record.js";
import { extractRawMessageText } from "../../../shared/message-content.js";
import type { ClinicState } from "../../state.js";
import { type ReplacementMeeting } from "../../booking-draft.js";

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
    return asJsonRecord(extractRawMessageText(message.content).trim())?.error
      === "Not authorized";
  });

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
  const body = extractRawMessageText(message.content).trim();
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
      const record = asJsonRecord(extractRawMessageText(message.content).trim());
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
    // Declined/failed/abandoned replacement cancellation outcomes are terminal.
    if (state.bookingDraft?.replacement != null) {
      // Failed/blocked/abandoned replacement cancel must close the session —
      // leaving cancelling + originalCommand would replay a stale create later.
      return outcome === "declined"
        || outcome === "abandoned"
        || outcome === "failed"
        || outcome === "blocked"
        ? message
        : null;
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
    return asJsonRecord(extractRawMessageText(message.content).trim()) ?? {};
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

/** Index of the latest pending_confirmation mutation ToolMessage, or -1. */
export const latestPendingConfirmationIndex = (messages: BaseMessage[]): number => {
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

/** Latest this-turn create_meeting JSON `error`, or undefined. */
export const latestCreateMeetingError = (messages: BaseMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const body = extractRawMessageText(message.content).trim();
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
    const record = asJsonRecord(extractRawMessageText(message.content).trim());
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

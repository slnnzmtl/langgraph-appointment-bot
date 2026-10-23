import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  extractMessageTextContent,
  labelIdFor,
} from "../../shared/message-content.js";
import { parseScheduleIntent } from "../../shared/booking-schedule.js";
import { isOtherDateChip } from "../../shared/other-date-chip.js";
import { resolveAvailabilityRequest } from "../../tools/availability-request.js";
import { kyivToday } from "../../tools/availability-slots.js";
import { authoritativeSelectedSlot } from "../agent-loop/booking-note-step.js";
import type { ClinicState } from "../state.js";

export type CancelTap = "abandon" | "visit" | "replace";

export const lastHumanLineFromMessages = (messages: BaseMessage[]): string => {
  const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return "";
  }
  const text = extractMessageTextContent(lastHuman.content).trim();
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? ""
  );
};

export const lastHumanTextFromMessages = (messages: BaseMessage[]): string => {
  const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return "";
  }
  return extractMessageTextContent(lastHuman.content).trim();
};

/** Exact «Головне меню» / Main menu only — free-text greetings use model intent. */
export const isGreetingOrMainMenuLine = (line: string): boolean =>
  labelIdFor(line) === "mainMenu";

const isCancelChip = (line: string): boolean =>
  labelIdFor(line) === "visitCancel";

/**
 * Classify a bare «Скасувати» / Cancel chip once for the turn.
 * null when the line is not a cancel chip. Free-text cancel uses supervisor
 * `intent: visit_cancel` — not patient-phrase matching.
 */
export const classifyCancelTap = (
  state: ClinicState,
  line: string,
): CancelTap | null => {
  if (!isCancelChip(line)) {
    return null;
  }
  const interaction = state.pendingInteraction;
  const replacementOpen =
    state.bookingDraft?.replacement?.status === "offered"
    || state.bookingDraft?.replacement?.status === "cancelling"
    || (interaction?.kind === "visit_select" && interaction.stage === "replacement");
  if (replacementOpen) {
    return "replace";
  }
  if (
    interaction?.kind === "visit_select"
    && (interaction.stage === "action" || interaction.stage === "meeting")
  ) {
    return "visit";
  }
  if (state.bookingDraft != null && authoritativeSelectedSlot(state) == null) {
    return "abandon";
  }
  if ((state.bookingContext?.meetings.length ?? 0) > 0) {
    return "visit";
  }
  return null;
};

/** Chip «Інша дата» or shared later-direction paraphrases — no growing sticky regex. */
export const isOtherDateReply = (human: string): boolean => {
  if (isOtherDateChip(human)) {
    return true;
  }
  return resolveAvailabilityRequest(human, kyivToday())?.kind === "later";
};

/** Calendar / clock / other-date intent from the shared schedule parser. */
export const isDayOrTimeReply = (human: string): boolean =>
  parseScheduleIntent(human, kyivToday(), { isOtherDateChip }) != null;

export const isPendingRescheduleSelection = (
  state: ClinicState,
  human: string,
  bookingContext: ClinicState["bookingContext"],
): boolean => {
  const visitSelect = state.pendingInteraction?.kind === "visit_select"
    ? state.pendingInteraction
    : null;
  const singleMeeting = (bookingContext?.meetings.length ?? 0) === 1;
  const actionStageWithMeeting =
    visitSelect?.stage === "action"
    && visitSelect.meetingId != null
    && singleMeeting;
  return actionStageWithMeeting && isDayOrTimeReply(human);
};

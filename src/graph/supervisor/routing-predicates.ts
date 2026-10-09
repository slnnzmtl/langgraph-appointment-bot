import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  SUPERVISOR_OWNED_REPLY_LABELS,
} from "../../shared/clinic-constants.js";
import {
  extractMessageTextContent,
  isYesReply,
  labelIdFor,
} from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { resolveAvailabilityRequest } from "../../tools/availability-request.js";
import { kyivToday } from "../../tools/availability-slots.js";
import { bookingTurnNeedsNoteOrchestrator } from "../booking-note-orchestrator.js";
import { interpretInteractionReply } from "../booking-session.js";
import type { ClinicState } from "../state.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "../types.js";
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

const isCancelChip = (line: string): boolean => {
  const id = labelIdFor(line);
  return id === "visitCancel" || id === "replaceCancel";
};

/**
 * Classify a bare «Скасувати» / Cancel chip once for the turn.
 * null when the line is not a cancel chip.
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
  if (
    (state.bookingDraft != null || state.selectedSlot != null)
    && state.bookingDraft?.selectedSlot == null
    && state.selectedSlot == null
  ) {
    return "abandon";
  }
  if ((state.bookingContext?.meetings.length ?? 0) > 0) {
    return "visit";
  }
  return null;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const OTHER_DATE_PATTERN = new RegExp(
  `(?:${[OTHER_DATE_LABEL, OTHER_DATE_LABEL_EN].map(escapeRegExp).join("|")}|інша\\s*дат|another\\s*date)`,
  "i",
);
const RUSSIAN_OTHER_DATE_PATTERN =
  /^(?:другая|другой|другую|другие)(?:\s+(?:дата|дату|даты|день|дни|вариант(?:ы)?))?$/i;

export const isOtherDateReply = (human: string): boolean =>
  OTHER_DATE_PATTERN.test(human) || RUSSIAN_OTHER_DATE_PATTERN.test(human.trim());

export const isDayOrTimeReply = (human: string): boolean =>
  resolveAvailabilityRequest(human, kyivToday()) != null
  || /\b\d{1,2}:\d{2}\b/.test(human)
  || isOtherDateReply(human);

export const shouldContinueInSpecialist = (
  state: ClinicState,
  agentId: string,
): boolean => {
  if (state.lastHandoff?.agentId !== agentId || state.lastHandoff.status !== "ok") {
    return false;
  }
  if (state.lastHandoff.yieldToSupervisor) {
    return false;
  }

  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return false;
  }
  const humanText = extractMessageTextContent(lastHuman.content).trim();
  if (!humanText || SUPERVISOR_OWNED_REPLY_LABELS.has(humanText)) {
    return false;
  }

  if (agentId === BOOKING_AGENT_ID && (state.availabilityContext != null || state.availabilityCursor != null)) {
    const availabilityRequest = resolveAvailabilityRequest(humanText, kyivToday());
    if (
      isOtherDateReply(humanText)
      || availabilityRequest?.kind === "exact"
      || availabilityRequest?.kind === "earlier"
      || availabilityRequest?.kind === "later"
      || availabilityRequest?.kind === "nearest"
    ) {
      return true;
    }
  }

  const interactionMatch = interpretInteractionReply(
    state.pendingInteraction,
    humanText,
  );
  if (interactionMatch.kind === "choice") {
    return true;
  }
  if (
    agentId === BOOKING_AGENT_ID
    && (state.pendingInteraction?.kind === "date_select"
      || state.pendingInteraction?.kind === "time_select"
      || state.pendingInteraction?.kind === "service_confirm"
      || state.pendingInteraction?.kind === "visit_note"
      || (state.pendingInteraction?.kind === "visit_select"
        && state.pendingInteraction.stage === "action"))
  ) {
    if (isDayOrTimeReply(humanText) || isOtherDateReply(humanText)) {
      return true;
    }
  }
  return false;
};

export const shouldContinueInBooking = (state: ClinicState): boolean =>
  shouldContinueInSpecialist(state, BOOKING_AGENT_ID);

export const shouldContinueInFaq = (state: ClinicState): boolean =>
  shouldContinueInSpecialist(state, FAQ_AGENT_ID);

/**
 * Sticky-route Перенести / visit-cancel / replace-cancel to booking.
 * Bare «Скасувати» without visit/replacement context is abandon (not sticky).
 */
export const isVisitChangeRouteLabel = (state: ClinicState): boolean => {
  const line = lastHumanLineFromMessages(state.messages);
  const id = labelIdFor(line);
  if (id === "visitReschedule") {
    return true;
  }
  // «Так» affirms cancel-and-rebook when a replacement offer is open
  // (interaction may not be restored yet on this turn).
  if (id === "offerAccept") {
    return state.bookingDraft?.replacement?.status === "offered"
      || state.bookingDraft?.replacement?.status === "cancelling"
      || (state.pendingInteraction?.kind === "visit_select"
        && state.pendingInteraction.stage === "replacement");
  }
  const cancelTap = classifyCancelTap(state, line);
  return cancelTap === "visit" || cancelTap === "replace";
};

export const stickyContinueAgentId = (
  state: ClinicState,
): typeof FAQ_AGENT_ID | typeof BOOKING_AGENT_ID | null => {
  if (isVisitChangeRouteLabel(state)) {
    return BOOKING_AGENT_ID;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const humanLine = lastHumanLineFromMessages(state.messages);
  const returnLabel = state.pendingInteraction?.choices.find(
    (choice) => choice.id === "return_to_booking",
  )?.label;
  if (returnLabel != null && human === returnLabel) {
    return BOOKING_AGENT_ID;
  }
  if (shouldContinueInFaq(state) || shouldStayInFaqCatalog(state)) {
    return FAQ_AGENT_ID;
  }
  if (
    bookingTurnNeedsNoteOrchestrator(state)
    && human.length > 0
    && !SUPERVISOR_OWNED_REPLY_LABELS.has(human)
    && !SUPERVISOR_OWNED_REPLY_LABELS.has(humanLine)
  ) {
    return BOOKING_AGENT_ID;
  }
  const agentId = state.lastHandoff?.agentId;
  if (agentId === FAQ_AGENT_ID || agentId === BOOKING_AGENT_ID) {
    return shouldContinueInSpecialist(state, agentId) ? agentId : null;
  }
  return null;
};

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

const isVisitChangeLabel = (human: string): boolean => {
  const id = labelIdFor(human);
  return id === "visitReschedule"
    || id === "visitCancel"
    || id === "replaceCancel";
};

const isSharedFaqRoutingExclusion = (human: string, humanLine: string): boolean =>
  human.length === 0
  || SUPERVISOR_OWNED_REPLY_LABELS.has(humanLine)
  || isYesReply(human)
  || isVisitChangeLabel(human)
  || normalizeClinicPhone(human) != null;

/**
 * Only the exact «Обрати іншу процедуру» chip pre-routes to FAQ.
 * Other free text on an open service_confirm defers to the supervisor LLM
 * (`intent: faq` / `book` / `consultation_request`).
 */
export const shouldRouteProcedureBrowseToFaq = (state: ClinicState): boolean => {
  if (state.pendingInteraction?.kind !== "service_confirm") {
    return false;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const match = interpretInteractionReply(state.pendingInteraction, human);
  return match.kind === "choice" && match.choiceId === "choose_other";
};

export const shouldStayInFaqCatalog = (state: ClinicState): boolean => {
  const handoff = state.lastHandoff;
  if (handoff?.agentId !== FAQ_AGENT_ID || handoff.status !== "ok") {
    return false;
  }
  if (handoff.yieldToSupervisor) {
    return false;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const humanLine = lastHumanLineFromMessages(state.messages);
  if (isSharedFaqRoutingExclusion(human, humanLine)) {
    return false;
  }
  const interaction = state.pendingInteraction;
  if (interaction?.kind === "catalog_detour") {
    const match = interpretInteractionReply(interaction, human);
    if (match.kind === "choice" && match.choiceId === "return_to_booking") {
      return false;
    }
    return true;
  }
  if (
    interaction?.kind === "service_candidate" && interaction.owner === "faq"
  ) {
    const match = interpretInteractionReply(interaction, human);
    if (match.kind === "choice") {
      return false;
    }
    return true;
  }
  return false;
};

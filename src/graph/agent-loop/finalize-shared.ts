import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";
import {
  extractMessageTextContent,
  isFaqServicesGuideLabel,
  labelIdFor,
} from "../../shared/message-content.js";
import type { BookingService } from "../booking-draft.js";
import { isFaqCatalogBrowseShortcut } from "../booking-entry-policy.js";
import { renderBookingInteractionMessage } from "../booking-interaction-render.js";
import {
  consultationService,
  type PendingInteraction,
} from "../booking-session.js";
import { isModelFailureMessage } from "../sub-agent-messages.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicHandoff,
  type ClinicHandoffStatus,
} from "../types.js";
import { toolRanThisTurn } from "./protocol.js";

export type FinalizeReply = {
  status: ClinicHandoffStatus;
  replyText: string;
  replyButtons: string[];
  replySource: "model" | "runtime";
  yieldToSupervisor: boolean;
  /** When false, fallback text is handoff-only (model-failure path). */
  persistMessage: boolean;
  patch: ClinicStateUpdate;
};

export const emptyFinalizeReply = (
  status: ClinicHandoffStatus = "ok",
): FinalizeReply => ({
  status,
  replyText: "",
  replyButtons: [],
  replySource: "model",
  yieldToSupervisor: false,
  persistMessage: true,
  patch: {},
});

export const lastHandoffFromReply = (
  agent: { id: string; name: string },
  reply: Pick<
    FinalizeReply,
    "status" | "replyText" | "replyButtons" | "yieldToSupervisor"
  >,
): ClinicHandoff => ({
  agentId: agent.id,
  agentName: agent.name,
  status: reply.status,
  ...(reply.replyText.length > 0 ? { replyText: reply.replyText } : {}),
  ...(reply.replyButtons.length > 0 ? { replyButtons: reply.replyButtons } : {}),
  ...(reply.yieldToSupervisor ? { yieldToSupervisor: true } : {}),
});

export const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (isModelFailureMessage(message)) {
    return "error";
  }

  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

/**
 * When the graph opens service_confirm it owns the only trailing question.
 * Drop any model-authored trailing question sentence so the patient never sees two.
 */
const stripTrailingQuestion = (text: string): string => {
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  const last = parts[parts.length - 1]!;
  if (!last.endsWith("?")) {
    return parts.join("\n\n").trim();
  }
  const boundary = Math.max(
    last.lastIndexOf("."),
    last.lastIndexOf("!"),
    last.lastIndexOf("\n"),
  );
  const withoutQuestion = boundary >= 0
    ? last.slice(0, boundary + (last[boundary] === "\n" ? 0 : 1)).trim()
    : "";
  if (withoutQuestion.length === 0) {
    parts.pop();
  } else {
    parts[parts.length - 1] = withoutQuestion;
  }
  trackEvent("faq_offer_question_dropped", { reason: "model_trailing_question" });
  return parts.join("\n\n").trim();
};

/** Patient text = optional model explanation + deterministic service_confirm question. */
export const withServiceConfirmQuestion = (
  modelText: string,
  interaction: PendingInteraction & { kind: "service_confirm" },
): string => {
  const question = String(renderBookingInteractionMessage(interaction).content);
  const explanation = stripTrailingQuestion(modelText);
  if (explanation.length === 0) {
    return question;
  }
  return `${explanation}\n\n${question}`;
};

/**
 * Resolve which CRM service a specialist is offering this turn without reading
 * offer-question wording. Keyboard chips open consultation; named CRM rows
 * come from FAQ `open_catalog` (model query), not patient-line title matching.
 */
export const offeredServiceForTurn = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
): BookingService | null => {
  if (state.bookingDraft?.serviceAcceptance?.status === "accepted") {
    return null;
  }
  // Mid-catalog drill-down is owned by FAQ service_candidate, not a book offer.
  if (
    state.pendingInteraction?.kind === "service_candidate"
    && state.pendingInteraction.owner === "faq"
  ) {
    return null;
  }
  const lastHuman = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  ).at(-1);
  const lastHumanText = lastHuman != null
    ? extractMessageTextContent(lastHuman.content).trim()
    : "";
  // «Обрати іншу процедуру» / bare «Ні» on an open offer — do not re-offer.
  if (isFaqCatalogBrowseShortcut(lastHumanText, state.pendingInteraction)) {
    return null;
  }
  if (state.bookingDraft?.serviceAcceptance?.status === "pending") {
    return state.bookingDraft.serviceAcceptance.service;
  }
  if (agentId !== FAQ_AGENT_ID && agentId !== BOOKING_AGENT_ID) {
    return null;
  }
  // «Послуги» / «Записатись» → consultation even when list_services ran this turn.
  if (
    labelIdFor(lastHumanText) === "mainBook"
    || isFaqServicesGuideLabel(lastHumanText)
  ) {
    return consultationService("catalog");
  }
  if (toolRanThisTurn(agentMessages, "list_services")) {
    return null;
  }
  return null;
};

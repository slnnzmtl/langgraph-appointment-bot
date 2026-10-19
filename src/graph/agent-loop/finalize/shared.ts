import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { trackEvent } from "../../../analytics/track.js";
import {
  CONSULTATION_SERVICE_ID,
  MAIN_MENU_GREETING_UK,
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../../../shared/clinic-constants.js";
import { claimsOutcome } from "../../../shared/outcome-claims.js";
import {
  extractMessageTextContent,
  isFaqServicesGuideLabel,
  labelIdFor,
} from "../../../shared/message-content.js";
import { defaultMenuHasVisit } from "../mutation-finalize.js";
import type { BookingService } from "../../booking-draft.js";
import { isFaqCatalogBrowseShortcut } from "../../booking-entry-policy.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../../booking-interaction-render.js";
import { renderFaqCatalogReply } from "../../faq-catalog.js";
import {
  consultationService,
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking-session.js";
import {
  isModelFailureMessage,
  tagRuntimeAgentMessage,
} from "../../sub-agent-messages.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicHandoff,
  type ClinicHandoffStatus,
} from "../../types.js";
import { lastPatientText, toolRanThisTurn } from "../protocol/index.js";

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

/** Shared no-AI FAQ catalog body; callers keep their own state patch. */
export const faqCatalogChipReply = (
  interaction: PendingInteraction & { kind: "service_candidate" },
  services: ServicesContext["list"] = [],
): { replyText: string; replyButtons: string[] } => ({
  replyText: renderFaqCatalogReply(interaction.choices, services),
  replyButtons: replyButtonsForInteraction(interaction),
});

/**
 * Structured service-offer synthesis for FAQ or booking when no slot/REPLACE
 * already owns the reply.
 */
export const applyServiceOfferSynthesis = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
  reply: FinalizeReply,
  opts: {
    alreadyBooked: boolean;
    slotOfferPresent: boolean;
    availabilityInteractionPresent: boolean;
    detailsStepActive: boolean;
  },
): { reply: FinalizeReply; serviceOfferUpdate: ClinicStateUpdate } => {
  let serviceOfferUpdate: ClinicStateUpdate = {};
  let next = reply;

  if (
    !opts.alreadyBooked
    && !opts.slotOfferPresent
    && !opts.availabilityInteractionPresent
    && state.pendingInteraction?.kind !== "service_confirm"
  ) {
    const offeredService = offeredServiceForTurn(state, agentId, agentMessages);
    if (offeredService != null) {
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "service_offered", service: offeredService },
      );
      serviceOfferUpdate = {
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      };
      if (session.pendingInteraction?.kind === "service_confirm") {
        const servicesGuide = isFaqServicesGuideLabel(lastPatientText(state));
        if (
          agentId === FAQ_AGENT_ID
          && servicesGuide
          && offeredService.id === CONSULTATION_SERVICE_ID
        ) {
          next = {
            ...next,
            replyText: withServiceConfirmQuestion(
              next.replyText,
              session.pendingInteraction,
            ),
          };
        } else if (next.replyText.length === 0) {
          next = {
            ...next,
            replyText: String(
              renderBookingInteractionMessage(session.pendingInteraction).content,
            ),
          };
        }
        if (!opts.detailsStepActive) {
          next = {
            ...next,
            replyButtons: replyButtonsForInteraction(session.pendingInteraction),
          };
        }
        if (agentId === FAQ_AGENT_ID) {
          next = { ...next, yieldToSupervisor: true };
        }
        trackEvent("reply_menu_filled", {
          menu: "service_confirm",
          reason: "pending_interaction",
        });
      }
    }
  } else if (
    state.pendingInteraction?.kind === "service_confirm"
    && !opts.detailsStepActive
    && !opts.alreadyBooked
    && !opts.slotOfferPresent
    && next.replyButtons.length === 0
  ) {
    if (next.replyText.length === 0) {
      next = {
        ...next,
        replyText: String(
          renderBookingInteractionMessage(state.pendingInteraction).content,
        ),
      };
    }
    next = {
      ...next,
      replyButtons: replyButtonsForInteraction(state.pendingInteraction),
    };
    if (agentId === FAQ_AGENT_ID) {
      next = { ...next, yieldToSupervisor: true };
    }
    trackEvent("reply_menu_filled", {
      menu: "service_confirm",
      reason: "pending_interaction",
    });
  }

  return { reply: next, serviceOfferUpdate };
};

/** Replace model prose that claims a CRM outcome the tools did not commit. */
export const applyFalseSuccessClaimOverride = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
  reply: FinalizeReply,
  mutationCommitted: boolean,
): FinalizeReply => {
  if (reply.replySource !== "model" || mutationCommitted) {
    return reply;
  }
  const claim = claimsOutcome(reply.replyText);
  if (claim == null) {
    return reply;
  }
  trackEvent("false_success_claim", {
    rule: claim.rule,
    phase: state.bookingDraft?.phase ?? null,
    agent: agentId,
  });
  trackEvent("reply_menu_filled", {
    menu: "default",
    reason: "false_success_claim",
  });
  return {
    ...reply,
    replyText: MAIN_MENU_GREETING_UK,
    replyButtons: [
      ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
    ],
    replySource: "runtime",
  };
};

/** Assemble AI-path finalize update (empty / max_steps / ok). */
export const finalizeAiUpdate = (input: {
  agent: { id: string; name: string; maxSteps: number };
  extras: ClinicStateUpdate;
  reply: FinalizeReply;
  replyMessage: AIMessage;
}): ClinicStateUpdate => {
  const { agent, extras, reply, replyMessage } = input;
  const lastHandoff = lastHandoffFromReply(agent, reply);
  if (reply.status === "empty") {
    return { ...extras, lastHandoff };
  }
  if (reply.status === "max_steps") {
    if (reply.replyText.length === 0) {
      console.error(
        `[clinic-${agent.id}] exceeded the maximum of ${agent.maxSteps} tool steps.`,
      );
    }
    return {
      ...extras,
      lastHandoff,
      messages: [
        reply.replyText.length > 0
          ? replyMessage
          : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
      ],
    };
  }
  return {
    ...extras,
    lastHandoff,
    messages: [replyMessage],
  };
};

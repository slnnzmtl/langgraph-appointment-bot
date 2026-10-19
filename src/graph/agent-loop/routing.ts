import { FAQ_AGENT_ID } from "../types.js";
import {
  findToolMessageByCallId,
  hasPendingToolCalls,
  lastMessageRequestsTools,
} from "../tool-routing.js";
import type { ClinicState } from "../state.js";
import {
  interpretInteractionReply,
  interactionChoiceEquals,
} from "../booking-session.js";
import {
  lastPatientText,
  phoneLookupFailedThisTurn,
  terminalContactWriteOutcome,
  terminalMeetingMutationOutcome,
} from "./protocol/index.js";

/**
 * FAQ LLM → tools or finalize. Booking no longer uses this path
 * (decide → tools → respond owns booking routing in compile.ts).
 */
export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
  _commandPrepareName?: string,
): string => {
  void _commandPrepareName;
  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }
  if (
    hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)
  ) {
    return toolsName;
  }
  return finalizeName;
};

/**
 * FAQ prepare → llm or finalize. Booking prepare was deleted; booking-only
 * planner projection branches are gone.
 */
export const routeAfterAgentPrepare = (
  state: ClinicState,
  llmName: string,
  _commandPrepareName?: string,
  _noteOrchestratorName?: string,
  finalizeName?: string,
  agentId?: string,
): string => {
  void _commandPrepareName;
  void _noteOrchestratorName;
  const isFaqPrepare = agentId === FAQ_AGENT_ID;
  // FAQ chips: exact chip taps skip LLM. Newly produced chips/confirm from prepare
  // set faqSkipLlm — do not infer from utterance equality or CRM stems.
  if (
    finalizeName
    && state.pendingInteraction?.kind === "service_candidate"
    && state.pendingInteraction.owner === "faq"
  ) {
    const catalogText = lastPatientText(state);
    const chipMatch = interpretInteractionReply(
      state.pendingInteraction,
      catalogText,
    );
    if (chipMatch.kind === "choice" || state.faqSkipLlm) {
      return finalizeName;
    }
  }
  // Graph-owned service_confirm from FAQ prepare. Do not skip when accepting («Так»).
  if (
    finalizeName
    && isFaqPrepare
    && state.pendingInteraction?.kind === "service_confirm"
    && state.bookingDraft?.serviceAcceptance?.status === "pending"
    && state.bookingDraft.replacement == null
  ) {
    const bookText = lastPatientText(state);
    const offerMatch = interpretInteractionReply(
      state.pendingInteraction,
      bookText,
    );
    if (!(offerMatch.kind === "choice" && interactionChoiceEquals(offerMatch.choiceId, "accept"))) {
      if (state.faqSkipLlm) {
        return finalizeName;
      }
    }
  }

  return llmName;
};

export type RouteAfterAgentToolsOptions = {
  llmName: string;
  toolsName: string;
  mutationFinalizeName?: string;
  commandPrepareName?: string;
  noteOrchestratorName?: string;
  finalizeName?: string;
  faqPrepareName?: string;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  options: RouteAfterAgentToolsOptions,
): string => {
  const {
    llmName,
    toolsName,
    mutationFinalizeName,
    finalizeName,
  } = options;

  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  // Failed contact writes / phone lookups are terminal for this turn.
  if (
    finalizeName
    && (terminalContactWriteOutcome(state) != null || phoneLookupFailedThisTurn(state))
  ) {
    return finalizeName;
  }

  // Not authorized → mutation_finalize patient-safe copy (not the LLM).
  if (mutationFinalizeName && terminalMeetingMutationOutcome(state) != null) {
    return mutationFinalizeName;
  }

  return llmName;
};

export type RouteAfterBookingToolsOptions = {
  decideName: string;
  toolsName: string;
  respondName: string;
};

/**
 * Booking tools → decide only after a ToolMessage whose tool_call_id matches
 * pendingEffect.id. No matching result (HITL interrupt, leftover stamp) → respond.
 */
export const routeAfterBookingTools = (
  state: ClinicState,
  options: RouteAfterBookingToolsOptions,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return options.toolsName;
  }
  const pendingId = state.bookingDraft?.pendingEffect?.id;
  if (findToolMessageByCallId(state.agentMessages, pendingId) != null) {
    return options.decideName;
  }
  return options.respondName;
};

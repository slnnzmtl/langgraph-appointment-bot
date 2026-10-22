import { FAQ_AGENT_ID } from "../types.js";
import {
  hasPendingToolCalls,
  lastMessageRequestsTools,
} from "../tool-routing.js";
import type { ClinicState } from "../state.js";
import {
  interpretInteractionReply,
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
  // FAQ chips: exact chip taps / newly produced chips skip LLM.
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
  void isFaqPrepare;

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
 * Booking tools → decide while an effect is open. Matching ToolMessage is
 * consumed in decide; missing match fail-closes there. Never dump an open
 * effect into respond (that shipped present_dates copy with an empty keyboard).
 */
export const routeAfterBookingTools = (
  state: ClinicState,
  options: RouteAfterBookingToolsOptions,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return options.toolsName;
  }
  if (state.bookingDraft?.pendingEffect?.id != null) {
    return options.decideName;
  }
  return options.respondName;
};

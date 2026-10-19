import { FAQ_AGENT_ID } from "../types.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import type { ClinicState } from "../state.js";
import { interpretInteractionReply } from "../booking-session.js";
import { bookingTurnNeedsNoteOrchestrator } from "../booking-note-orchestrator.js";
import {
  bookingOutcomeNeedsPrepare,
  hasPendingConfirmationChatOther,
  resolveBookingCommand,
  type BookingCommandOutcome,
} from "./booking-command.js";
import {
  lastPatientText,
  phoneLookupFailedThisTurn,
  terminalContactWriteOutcome,
  terminalMeetingMutationOutcome,
} from "./protocol/index.js";

const routeNeedsCommandPrepare = (state: ClinicState): boolean =>
  bookingOutcomeNeedsPrepare(resolveBookingCommand(state));

/**
 * Project a planner outcome onto a named graph node. FAQ prepare is graph
 * topology (catalog owner), not a second copy of booking policy.
 */
const routeFromBookingOutcome = (
  outcome: BookingCommandOutcome,
  options: {
    commandPrepareName?: string;
    finalizeName?: string;
    faqPrepareName?: string;
    llmName: string;
  },
): string | null => {
  if (outcome.kind === "finalize") {
    if (outcome.reason === "replacement_catalog" && options.faqPrepareName) {
      return options.faqPrepareName;
    }
    if (options.finalizeName) {
      return options.finalizeName;
    }
    return null;
  }
  if (options.commandPrepareName && bookingOutcomeNeedsPrepare(outcome)) {
    return options.commandPrepareName;
  }
  return null;
};

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
  commandPrepareName?: string,
): string => {
  // Abort-mutation during unresolved HITL is planner-owned (continue_llm).
  if (commandPrepareName && routeNeedsCommandPrepare(state)) {
    return commandPrepareName;
  }

  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  // FAQ agents have no command_prepare; pending model tools go straight to ToolNode.
  if (
    !commandPrepareName
    && (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages))
  ) {
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentPrepare = (
  state: ClinicState,
  llmName: string,
  commandPrepareName?: string,
  noteOrchestratorName?: string,
  finalizeName?: string,
  agentId?: string,
): string => {
  void noteOrchestratorName;
  const isFaqPrepare = agentId === FAQ_AGENT_ID;
  // Graph-owned REPLACE: skip the LLM and render visit_select / replacement.
  // Booking agent only — FAQ prepare must not project booking replacement policy.
  if (
    !isFaqPrepare
    && finalizeName
    && state.bookingDraft?.replacement?.status === "offered"
    && !(
      state.pendingInteraction?.kind === "visit_select"
      && state.pendingInteraction.stage === "replacement"
    )
  ) {
    return finalizeName;
  }
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
  // Graph-owned service_confirm from prepare. Do not skip when accepting («Так»).
  // FAQ: skip LLM only when prepare set faqSkipLlm. Price / compare on an
  // already-open confirm reach faq__llm. Booking: only when prepare set
  // bookingSkipLlm (new/restored card) — never from contact ownership.
  if (
    finalizeName
    && state.pendingInteraction?.kind === "service_confirm"
    && state.bookingDraft?.serviceAcceptance?.status === "pending"
    && state.bookingDraft.replacement == null
  ) {
    const bookText = lastPatientText(state);
    const offerMatch = interpretInteractionReply(
      state.pendingInteraction,
      bookText,
    );
    if (!(offerMatch.kind === "choice" && offerMatch.choiceId === "accept")) {
      if (isFaqPrepare && state.faqSkipLlm) {
        return finalizeName;
      }
    }
  }

  // Booking planner projection — booking agent only. FAQ prepare keeps catalog
  // handling above and otherwise continues to faq__llm (e.g. contact_field detour).
  if (!isFaqPrepare) {
    const outcome = resolveBookingCommand(state);
    const projected = routeFromBookingOutcome(outcome, {
      llmName,
      ...(commandPrepareName != null ? { commandPrepareName } : {}),
      ...(finalizeName != null ? { finalizeName } : {}),
    });
    if (projected != null) {
      return projected;
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
    commandPrepareName,
    noteOrchestratorName,
    finalizeName,
    faqPrepareName,
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

  // Booking planner projection — only when this agent loop owns prepare/finalize.
  if (commandPrepareName || finalizeName || faqPrepareName) {
    const outcome = resolveBookingCommand(state);
    const projected = routeFromBookingOutcome(outcome, {
      llmName,
      ...(commandPrepareName != null ? { commandPrepareName } : {}),
      ...(finalizeName != null ? { finalizeName } : {}),
      ...(faqPrepareName != null ? { faqPrepareName } : {}),
    });
    if (projected != null) {
      return projected;
    }
  }

  if (
    noteOrchestratorName
    && hasPendingConfirmationChatOther(state)
    && bookingTurnNeedsNoteOrchestrator(state)
  ) {
    return noteOrchestratorName;
  }

  return llmName;
};

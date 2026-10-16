import { FAQ_AGENT_ID } from "../types.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import { labelIdFor, normalizeReplyLabel } from "../../shared/message-content.js";
import type { ClinicState } from "../state.js";
import { utteranceHasCatalogCrmEvidence } from "../booking-entry-policy.js";
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
} from "./protocol.js";
import { resolveContactIdentity } from "../contact-command.js";

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
  if (noteOrchestratorName && state.noteOrchQueued) {
    return noteOrchestratorName;
  }
  // Graph-owned REPLACE: skip the LLM and render visit_select / replacement.
  if (
    finalizeName
    && state.bookingDraft?.replacement?.status === "offered"
    && !(
      state.pendingInteraction?.kind === "visit_select"
      && state.pendingInteraction.stage === "replacement"
    )
  ) {
    return finalizeName;
  }
  // FAQ chips opened/narrowed by a chip tap, named_procedure, or mid-catalog
  // rematch in prepare — skip LLM. Unmatched prose that did not rematch reaches
  // the FAQ model (price / compare / keep_catalog).
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
    // Catalog chips skip the FAQ LLM. Bare «ні» must not wipe drill-down.
    if (chipMatch.kind === "choice") {
      return finalizeName;
    }
    // Named-procedure entry or rematch just opened these chips from this line.
    if (
      state.supervisorIntent === "named_procedure"
      || (
        catalogText.length > 0
        && normalizeReplyLabel(state.pendingInteraction.utterance)
          === normalizeReplyLabel(catalogText)
      )
    ) {
      return finalizeName;
    }
  }
  // Graph-owned service_confirm from prepare. Do not skip when accepting («Так»).
  // FAQ: skip LLM only when this turn opened the card (named_procedure or
  // patient line has CRM stems for the offered service). Price / compare on an
  // already-open confirm reach faq__llm. Booking: mainBook / owned-idle.
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
      if (agentId === FAQ_AGENT_ID) {
        const offered = state.pendingInteraction.service;
        const offeredName = offered.name ?? "";
        const offeredServices =
          offeredName.length > 0
            ? [{
                id: offered.id,
                name: offeredName,
                ...(offered.durationMinutes != null
                  ? { duration: offered.durationMinutes }
                  : {}),
              }]
            : [];
        const openedThisTurn =
          state.supervisorIntent === "named_procedure"
          || utteranceHasCatalogCrmEvidence({
            text: bookText,
            services: offeredServices,
          });
        if (openedThisTurn) {
          return finalizeName;
        }
      } else if (
        labelIdFor(bookText) === "mainBook"
        || (
          (state.bookingContext?.meetings.length ?? 0) === 0
          && resolveContactIdentity(state.contactContext).kind === "owned"
        )
      ) {
        return finalizeName;
      }
    }
  }

  const outcome = resolveBookingCommand(state);
  // FAQ price/compare on an already-open confirm must reach the FAQ LLM —
  // do not project pending_interaction finalize there (FAQ-owned carve-out).
  if (
    !(
      agentId === FAQ_AGENT_ID
      && outcome.kind === "finalize"
      && outcome.reason === "pending_interaction"
      && state.pendingInteraction?.kind === "service_confirm"
    )
  ) {
    const projected = routeFromBookingOutcome(outcome, {
      llmName,
      ...(commandPrepareName != null ? { commandPrepareName } : {}),
      ...(finalizeName != null ? { finalizeName } : {}),
    });
    if (projected != null) {
      return projected;
    }
  } else if (commandPrepareName && bookingOutcomeNeedsPrepare(outcome)) {
    return commandPrepareName;
  }

  return llmName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
  mutationFinalizeName?: string,
  commandPrepareName?: string,
  noteOrchestratorName?: string,
  finalizeName?: string,
  faqPrepareName?: string,
): string => {
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

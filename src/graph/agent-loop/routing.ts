import { FAQ_AGENT_ID } from "../types.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import { labelIdFor, normalizeReplyLabel } from "../../shared/message-content.js";
import type { ClinicState } from "../state.js";
import { matchingCatalogRows } from "../catalog-match.js";
import { interpretInteractionReply } from "../booking-session.js";
import { bookingTurnNeedsNoteOrchestrator } from "../booking-note-orchestrator.js";
import {
  bookingCommandContinuesAfterTools,
  bookingTurnNeedsCommandPreparation,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
  shouldRearmCancelAfterChatOther,
} from "./booking-command.js";
import {
  lastPatientText,
  phoneLookupFailedThisTurn,
  terminalContactWriteOutcome,
  terminalMeetingMutationOutcome,
  toolRanThisTurn,
} from "./protocol.js";
import { resolveContactIdentity } from "../contact-command.js";

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
  commandPrepareName?: string,
): string => {
  // Cancel chat-other re-arm outranks a model mutation call during unresolved
  // confirm (command_prepare replaces it). Other agents still finalize.
  if (
    commandPrepareName
    && hasMutationCallDuringUnresolvedConfirmation(state)
    && !shouldRearmCancelAfterChatOther(state)
  ) {
    return finalizeName;
  }

  // Runtime-owned booking transitions outrank both model text and the model's
  // step budget. Once canonical state is ready, no LLM-authored terminal claim
  // is eligible for finalization.
  if (commandPrepareName && bookingTurnNeedsCommandPreparation(state)) {
    return commandPrepareName;
  }

  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    if (commandPrepareName) {
      return commandPrepareName;
    }
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
        const offeredName = offered.name;
        const openedThisTurn =
          state.supervisorIntent === "named_procedure"
          || (
            offeredName != null
            && offeredName.length > 0
            && matchingCatalogRows(bookText, [{
              id: offered.id,
              name: offeredName,
              ...(offered.durationMinutes != null
                ? { duration: offered.durationMinutes }
                : {}),
            }]).length > 0
          );
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
  return commandPrepareName && bookingTurnNeedsCommandPreparation(state)
    ? commandPrepareName
    : llmName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
  mutationFinalizeName?: string,
  commandPrepareName?: string,
  noteOrchestratorName?: string,
  finalizeName?: string,
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

  // Contact incomplete / consultation agreement → command_prepare (typed recovery).
  if (commandPrepareName && bookingCommandContinuesAfterTools(state)) {
    return commandPrepareName;
  }

  // Ownership / link-candidate / consultation strips open a pending interaction
  // without a ToolMessage — finalize renders the card.
  if (
    finalizeName
    && state.pendingInteraction != null
    && (
      state.pendingInteraction.kind === "contact_field"
      || (
        state.pendingInteraction.kind === "service_confirm"
        && state.bookingDraft?.serviceAcceptance?.status === "pending"
      )
    )
    && !hasPendingToolCalls(state.agentMessages)
  ) {
    return finalizeName;
  }

  // REPLACE cancel with no frozen create: finalize renders the next booking step
  // (FAQ catalog guide, consultation offer, or date/time after accepted service).
  if (
    finalizeName
    && state.pendingCancellationPurpose === "replacement"
    && state.bookingDraft?.mode === "create"
    && state.bookingDraft.replacement == null
    && toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")
    && (
      state.pendingInteraction?.kind === "service_confirm"
      || (
        state.pendingInteraction?.kind === "service_candidate"
        && state.pendingInteraction.owner === "faq"
      )
      || toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    )
  ) {
    return finalizeName;
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

import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, Overwrite } from "@langchain/langgraph";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../../types.js";
import {
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../../../shared/clinic-constants.js";
import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractReplyButtons,
} from "../../../shared/message-content.js";
import { clearPendingConfirmForRuntime } from "../../../tools/meeting-confirm.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import { isModelFailureMessage, tagRuntimeAgentMessage } from "../../sub-agent-messages.js";
import {
  applyMutationChatOtherCleanup,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
} from "../booking-command.js";
import { createAgentMutationFinalizeNode } from "../mutation-finalize.js";
import { terminalMeetingMutationOutcome } from "../protocol.js";
import {
  applyBookingDefaultMenuButtons,
  applyBookingFalseSuccessGuard,
  applyBookingOutcomeRisk,
  applyBookingPresentPaths,
  availabilityPresentedUpdate,
  finalizeNonAiBooking,
  initBookingAiReplyBag,
  noteStatusForHandoffUpdate,
} from "./booking.js";
import { finalizeNonAiContactFailures } from "./contact.js";
import {
  applyFaqAiCatalogShaping,
  applyServiceConfirmOfferShaping,
  finalizeNonAiFaq,
  offeredServiceForTurn,
} from "./faq.js";
import { resolveHandoffStatus } from "./shared.js";

export type CreateAgentFinalizeOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

export { offeredServiceForTurn };

export const createAgentFinalizeNode = (
  agent: ClinicAgentDefinition,
  options?: CreateAgentFinalizeOptions,
) =>
  async (
    state: ClinicState,
    config?: RunnableConfig,
  ): Promise<ClinicStateUpdate | Command> => {
    const agentMessages = state.agentMessages ?? [];
    if (terminalMeetingMutationOutcome(state) != null) {
      // Includes main-menu leave → Command({ goto: "supervisor" }).
      return createAgentMutationFinalizeNode(agent)(state, config);
    }
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
    };
    const chatOther = hasPendingConfirmationChatOther(state);
    const confirmationCleanup = chatOther
      ? applyMutationChatOtherCleanup(state)
      : {};
    if (chatOther) {
      clearPendingConfirmForRuntime(config);
    }

    if (!(lastMessage instanceof AIMessage)) {
      const contactFailure = finalizeNonAiContactFailures(
        agent,
        state,
        cleared,
        confirmationCleanup,
      );
      if (contactFailure != null) {
        return contactFailure;
      }
      const bookingNonAi = finalizeNonAiBooking(
        agent,
        state,
        agentMessages,
        cleared,
        confirmationCleanup,
      );
      if (bookingNonAi != null) {
        return bookingNonAi;
      }
      const faqNonAi = finalizeNonAiFaq(agent, state, cleared, confirmationCleanup);
      if (faqNonAi != null) {
        return faqNonAi;
      }
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(tagged.content);
    // Catalog control is the parsed tag only; every tag shape is stripped from text.
    const {
      text: textWithoutCatalogAction,
      action: faqCatalogAction,
      query: faqCatalogQuery,
    } = extractFaqCatalogAction(rawText);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(textWithoutCatalogAction);

    const bag = initBookingAiReplyBag(
      agent,
      state,
      agentMessages,
      text.trim(),
      chatOther,
    );

    // Model failure: deliver via handoff only — do not persist into conversation history.
    if (status === "error" && isModelFailureMessage(tagged)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "error",
          replyText: PATIENT_FALLBACK_MESSAGE,
          ...(agent.id === BOOKING_AGENT_ID
            ? { replyButtons: [...defaultMenuLabels(hasVisit)] }
            : {}),
        },
      };
    }

    const presentBranch = applyBookingPresentPaths(agent, state, agentMessages, bag);
    if (presentBranch === "none" && agent.id === FAQ_AGENT_ID) {
      await applyFaqAiCatalogShaping(
        state,
        faqCatalogAction,
        faqCatalogQuery,
        bag,
        options,
      );
    } else if (presentBranch === "none") {
      applyBookingDefaultMenuButtons(agent, state, agentMessages, bag);
    }

    applyBookingOutcomeRisk(agent, state, agentMessages, bag);
    applyBookingFalseSuccessGuard(agent, state, agentMessages, bag);

    if (yieldTag && agent.id === FAQ_AGENT_ID) {
      bag.yieldFlag = true;
    }

    const noteStatusForHandoff = noteStatusForHandoffUpdate(state, bag);

    applyServiceConfirmOfferShaping(agent, state, agentMessages, bag);

    const availabilityInteractionUpdate = availabilityPresentedUpdate(state, bag);
    const bookingDraftOfferUpdate = bag.serviceOfferUpdate;
    const blockedConfirmationMutation =
      hasMutationCallDuringUnresolvedConfirmation(state);

    const replyMessage =
      bag.replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || bag.slotOffer != null
        || blockedConfirmationMutation
        ? new AIMessage({
            content: bag.replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(bag.replyText.length > 0 ? { replyText: bag.replyText } : {}),
      ...(bag.replyButtons.length > 0 ? { replyButtons: bag.replyButtons } : {}),
      ...(bag.yieldFlag ? { yieldToSupervisor: true } : {}),
    };
    const serviceChangeNoticeClear: { serviceChangeNotice?: null } =
      bag.clearServiceChangeNotice ? { serviceChangeNotice: null } : {};
    // One-turn named_procedure gate — consume after FAQ (or any) finalize.
    const supervisorIntentClear: { supervisorIntent: null } = { supervisorIntent: null };

    if (status === "empty") {
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        ...bookingDraftOfferUpdate,
        ...availabilityInteractionUpdate,
        ...bag.visitSelectUpdate,
        ...bag.contactFieldUpdate,
        ...confirmationCleanup,
        ...bag.clearOccupiedPhoneCandidate,
        ...serviceChangeNoticeClear,
        ...supervisorIntentClear,
      };
    }

    if (status === "max_steps") {
      if (bag.replyText.length === 0) {
        console.error(
          `[clinic-${agent.id}] exceeded the maximum of ${agent.maxSteps} tool steps.`,
        );
      }
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        ...bookingDraftOfferUpdate,
        ...availabilityInteractionUpdate,
        ...bag.visitSelectUpdate,
        ...bag.contactFieldUpdate,
        ...confirmationCleanup,
        ...bag.clearOccupiedPhoneCandidate,
        ...serviceChangeNoticeClear,
        ...supervisorIntentClear,
        messages: [
          bag.replyText.length > 0
            ? replyMessage
            : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
      ...noteStatusForHandoff,
      ...bookingDraftOfferUpdate,
      ...availabilityInteractionUpdate,
      ...bag.visitSelectUpdate,
      ...bag.contactFieldUpdate,
      ...confirmationCleanup,
      ...bag.clearOccupiedPhoneCandidate,
      ...serviceChangeNoticeClear,
      ...supervisorIntentClear,
      messages: [replyMessage],
    };
  };

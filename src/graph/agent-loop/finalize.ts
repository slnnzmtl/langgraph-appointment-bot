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
} from "../types.js";
import {
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractReplyButtons,
} from "../../shared/message-content.js";
import { clearPendingConfirmForRuntime } from "../../tools/meeting-confirm.js";
import type { ServicesContext } from "../../tools/service-tools.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../service-resolution.js";
import { isModelFailureMessage, tagRuntimeAgentMessage } from "../sub-agent-messages.js";
import {
  applyMutationChatOtherCleanup,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
} from "./booking-command.js";
import {
  createAgentMutationFinalizeNode,
} from "./mutation-finalize.js";
import {
  mutationCommittedThisTurn,
  terminalMeetingMutationOutcome,
} from "./protocol.js";
import {
  applyBookingOutcomeRiskOverride,
  applyBookingPrimaryReply,
  applyFalseSuccessClaimOverride,
  availabilityPresentedUpdate,
  noteStatusHandoffUpdate,
  tryBookingNoAiFinalize,
} from "./finalize-booking.js";
import {
  applyFaqCatalogAiFinalize,
  tryFaqNoAiFinalize,
} from "./finalize-faq.js";
import {
  applyServiceOfferSynthesis,
  emptyFinalizeReply,
  finalizeAiUpdate,
  lastHandoffFromReply,
  offeredServiceForTurn,
  resolveHandoffStatus,
  type FinalizeReply,
} from "./finalize-shared.js";
import type {
  DateSelectInteraction,
  PendingInteraction,
  TimeSelectInteraction,
} from "../booking-session.js";

export type CreateAgentFinalizeOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** Re-export for existing tests that import from finalize.js. */
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
      return createAgentMutationFinalizeNode(agent)(state, config);
    }
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared: ClinicStateUpdate = {
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
      const noAi = agent.id === BOOKING_AGENT_ID
        ? tryBookingNoAiFinalize(state, agentMessages)
        : agent.id === FAQ_AGENT_ID
          ? tryFaqNoAiFinalize(state)
          : null;
      if (noAi != null) {
        return {
          ...cleared,
          ...confirmationCleanup,
          ...noAi.patch,
          messages: [
            tagRuntimeAgentMessage(new AIMessage(noAi.replyText), agent.id),
          ],
          lastHandoff: lastHandoffFromReply(agent, noAi),
        };
      }
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: lastHandoffFromReply(agent, emptyFinalizeReply("empty")),
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(tagged.content);
    const {
      text: textWithoutCatalogAction,
    } = extractFaqCatalogAction(rawText);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(textWithoutCatalogAction);

    let reply: FinalizeReply = {
      ...emptyFinalizeReply(status),
      replyText: text.trim(),
    };

    let clearServiceChangeNotice = false;
    const consumeServiceChangeNotice = (): string | null => {
      const notice = state.serviceChangeNotice;
      if (notice == null || notice.length === 0) {
        return null;
      }
      clearServiceChangeNotice = true;
      return notice;
    };

    if (status === "error" && isModelFailureMessage(tagged)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      reply = {
        ...emptyFinalizeReply("error"),
        replyText: PATIENT_FALLBACK_MESSAGE,
        ...(agent.id === BOOKING_AGENT_ID
          ? { replyButtons: [...defaultMenuLabels(hasVisit)] }
          : {}),
        persistMessage: false,
        replySource: "runtime",
      };
    }

    if (!reply.persistMessage) {
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: lastHandoffFromReply(agent, reply),
      };
    }

    let contactFieldUpdate: ClinicStateUpdate = {};
    let clearOccupiedPhoneCandidate: ClinicStateUpdate = {};
    let visitSelectUpdate: ClinicStateUpdate = {};
    let serviceOfferUpdate: ClinicStateUpdate = {};
    let availabilityInteraction:
      DateSelectInteraction | TimeSelectInteraction | null = null;
    let awaitingNote = false;
    let alreadyBooked = false;
    let mutationCommitted = false;
    let createError: string | null | undefined = null;
    let detailsStep: { replyText: string; interaction: PendingInteraction } | null = null;
    let slotOfferPresent = false;
    let replacementOffered = false;

    if (agent.id === BOOKING_AGENT_ID) {
      const primary = applyBookingPrimaryReply({
        state,
        agentMessages,
        reply,
        chatOther,
        consumeServiceChangeNotice,
      });
      reply = primary.reply;
      availabilityInteraction = primary.availabilityInteraction;
      contactFieldUpdate = primary.contactFieldUpdate;
      clearOccupiedPhoneCandidate = primary.clearOccupiedPhoneCandidate;
      visitSelectUpdate = primary.visitSelectUpdate;
      serviceOfferUpdate = primary.serviceOfferUpdate;
      awaitingNote = primary.awaitingNote;
      alreadyBooked = primary.alreadyBooked;
      mutationCommitted = primary.mutationCommitted;
      createError = primary.createError;
      detailsStep = primary.detailsStep;
      slotOfferPresent = primary.slotOfferPresent;
      replacementOffered = primary.replacementOffered;

      const risk = applyBookingOutcomeRiskOverride({
        state,
        agentMessages,
        reply,
        chatOther,
        consumeServiceChangeNotice,
        alreadyBooked,
        createCommitted: primary.createCommitted,
        createError,
        detailsStep,
        availabilityInteraction,
        slotOfferPresent,
        replacementOffered,
      });
      reply = risk.reply;
      availabilityInteraction = risk.availabilityInteraction;
    } else if (agent.id === FAQ_AGENT_ID) {
      mutationCommitted = mutationCommittedThisTurn(agentMessages);

      const faqResult = await applyFaqCatalogAiFinalize(
        state,
        reply,
        rawText,
        options,
      );
      reply = faqResult.reply;
      serviceOfferUpdate = faqResult.serviceOfferUpdate;
    }

    if (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID) {
      reply = applyFalseSuccessClaimOverride(
        state,
        agent.id,
        agentMessages,
        reply,
        mutationCommitted,
      );
    }

    if (yieldTag && agent.id === FAQ_AGENT_ID) {
      reply = { ...reply, yieldToSupervisor: true };
    }

    const noteStatusForHandoff = agent.id === BOOKING_AGENT_ID
      ? noteStatusHandoffUpdate(state, awaitingNote, slotOfferPresent)
      : {};

    if (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID) {
      const synthesis = applyServiceOfferSynthesis(
        state,
        agent.id,
        agentMessages,
        reply,
        {
          alreadyBooked,
          slotOfferPresent,
          availabilityInteractionPresent: availabilityInteraction != null,
          detailsStepActive: detailsStep != null,
        },
      );
      if (Object.keys(synthesis.serviceOfferUpdate).length > 0) {
        serviceOfferUpdate = synthesis.serviceOfferUpdate;
      }
      reply = synthesis.reply;
    }

    const availabilityInteractionUpdate =
      agent.id === BOOKING_AGENT_ID
        ? availabilityPresentedUpdate(state, availabilityInteraction)
        : {};

    const blockedConfirmationMutation =
      hasMutationCallDuringUnresolvedConfirmation(state);

    const replyMessage =
      reply.replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || slotOfferPresent
        || blockedConfirmationMutation
        ? new AIMessage({
            content: reply.replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    // Merge order must match historical extras: note → service offer →
    // availability presented → visit → contact field → chat-other →
    // occupied-phone clear → notice → supervisorIntent.
    reply = {
      ...reply,
      patch: {
        ...noteStatusForHandoff,
        ...serviceOfferUpdate,
        ...availabilityInteractionUpdate,
        ...visitSelectUpdate,
        ...contactFieldUpdate,
        ...confirmationCleanup,
        ...clearOccupiedPhoneCandidate,
        ...(clearServiceChangeNotice ? { serviceChangeNotice: null } : {}),
        supervisorIntent: null,
        ...reply.patch,
      },
    };

    return finalizeAiUpdate({
      agent,
      extras: { ...cleared, ...reply.patch },
      reply,
      replyMessage,
    });
  };

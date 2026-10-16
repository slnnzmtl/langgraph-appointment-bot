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
import {
  createAgentMutationFinalizeNode,
} from "../mutation-finalize.js";
import {
  mutationCommittedThisTurn,
  terminalMeetingMutationOutcome,
} from "../protocol.js";
import {
  applyBookingOutcomeRiskOverride,
  applyBookingPrimaryReply,
  applyFalseSuccessClaimOverride,
  availabilityPresentedUpdate,
  noteStatusHandoffUpdate,
  tryBookingNoAiFinalize,
} from "./booking.js";
import {
  applyFaqCatalogAiFinalize,
  tryFaqNoAiFinalize,
  type FinalizeFaqOptions,
} from "./faq.js";
import {
  applyServiceOfferSynthesis,
  emptyFinalizeReply,
  finalizeAiUpdate,
  lastHandoffFromReply,
  offeredServiceForTurn,
  resolveHandoffStatus,
  type FinalizeReply,
} from "./shared.js";

export type CreateAgentFinalizeOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** Re-export for existing tests that import from finalize.js. */
export { offeredServiceForTurn };

/** Assemble AI-path finalize update (empty / max_steps / ok). */
export const assembleFinalize = finalizeAiUpdate;

export type FinalizeBookingAiInput = {
  state: ClinicState;
  agentMessages: BaseMessage[];
  reply: FinalizeReply;
  chatOther: boolean;
  consumeServiceChangeNotice: () => string | null;
  confirmationCleanup: ClinicStateUpdate;
};

/**
 * Booking AI finalize: pure helpers → immutable FinalizeReply.
 * Extras land on reply.patch; no shared mutable bag.
 */
export const finalizeBookingAi = (
  input: FinalizeBookingAiInput,
): FinalizeReply => {
  const {
    state,
    agentMessages,
    chatOther,
    confirmationCleanup,
  } = input;
  let reply = input.reply;
  let clearServiceChangeNotice = false;
  const consumeServiceChangeNotice = (): string | null => {
    const notice = input.consumeServiceChangeNotice();
    if (notice != null) {
      clearServiceChangeNotice = true;
    }
    return notice;
  };

  const primary = applyBookingPrimaryReply({
    state,
    agentMessages,
    reply,
    chatOther,
    consumeServiceChangeNotice,
  });
  reply = primary.reply;

  const risk = applyBookingOutcomeRiskOverride({
    state,
    agentMessages,
    reply,
    chatOther,
    consumeServiceChangeNotice,
    alreadyBooked: primary.alreadyBooked,
    createCommitted: primary.createCommitted,
    createError: primary.createError,
    detailsStep: primary.detailsStep,
    availabilityInteraction: primary.availabilityInteraction,
    slotOfferPresent: primary.slotOfferPresent,
    replacementOffered: primary.replacementOffered,
  });
  reply = risk.reply;
  const availabilityInteraction = risk.availabilityInteraction;

  reply = applyFalseSuccessClaimOverride(
    state,
    BOOKING_AGENT_ID,
    agentMessages,
    reply,
    primary.mutationCommitted,
  );

  const noteStatusForHandoff = noteStatusHandoffUpdate(
    state,
    primary.awaitingNote,
    primary.slotOfferPresent,
  );

  const synthesis = applyServiceOfferSynthesis(
    state,
    BOOKING_AGENT_ID,
    agentMessages,
    reply,
    {
      alreadyBooked: primary.alreadyBooked,
      slotOfferPresent: primary.slotOfferPresent,
      availabilityInteractionPresent: availabilityInteraction != null,
      detailsStepActive: primary.detailsStep != null,
    },
  );
  reply = synthesis.reply;
  const serviceOfferUpdate = Object.keys(synthesis.serviceOfferUpdate).length > 0
    ? synthesis.serviceOfferUpdate
    : primary.serviceOfferUpdate;

  const availabilityInteractionUpdate = availabilityPresentedUpdate(
    state,
    availabilityInteraction,
  );

  return {
    ...reply,
    patch: {
      ...noteStatusForHandoff,
      ...serviceOfferUpdate,
      ...availabilityInteractionUpdate,
      ...primary.visitSelectUpdate,
      ...primary.contactFieldUpdate,
      ...confirmationCleanup,
      ...primary.clearOccupiedPhoneCandidate,
      ...(clearServiceChangeNotice ? { serviceChangeNotice: null } : {}),
      supervisorIntent: null,
      ...reply.patch,
    },
  };
};

export type FinalizeFaqAiInput = {
  state: ClinicState;
  agentMessages: BaseMessage[];
  reply: FinalizeReply;
  rawText: string;
  yieldTag: boolean;
  confirmationCleanup: ClinicStateUpdate;
  options?: FinalizeFaqOptions;
};

/**
 * FAQ AI finalize: pure helpers → immutable FinalizeReply.
 * Does not import or mutate booking bags.
 */
export const finalizeFaqAi = async (
  input: FinalizeFaqAiInput,
): Promise<FinalizeReply> => {
  const {
    state,
    agentMessages,
    rawText,
    yieldTag,
    confirmationCleanup,
    options,
  } = input;
  let reply = input.reply;

  const mutationCommitted = mutationCommittedThisTurn(agentMessages);
  const faqResult = await applyFaqCatalogAiFinalize(
    state,
    reply,
    rawText,
    options,
  );
  reply = faqResult.reply;
  let serviceOfferUpdate = faqResult.serviceOfferUpdate;

  reply = applyFalseSuccessClaimOverride(
    state,
    FAQ_AGENT_ID,
    agentMessages,
    reply,
    mutationCommitted,
  );

  if (yieldTag) {
    reply = { ...reply, yieldToSupervisor: true };
  }

  const synthesis = applyServiceOfferSynthesis(
    state,
    FAQ_AGENT_ID,
    agentMessages,
    reply,
    {
      alreadyBooked: false,
      slotOfferPresent: false,
      availabilityInteractionPresent: false,
      detailsStepActive: false,
    },
  );
  if (Object.keys(synthesis.serviceOfferUpdate).length > 0) {
    serviceOfferUpdate = synthesis.serviceOfferUpdate;
  }
  reply = synthesis.reply;

  return {
    ...reply,
    patch: {
      ...serviceOfferUpdate,
      ...confirmationCleanup,
      supervisorIntent: null,
      ...reply.patch,
    },
  };
};

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

    const consumeServiceChangeNotice = (): string | null => {
      const notice = state.serviceChangeNotice;
      if (notice == null || notice.length === 0) {
        return null;
      }
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

    if (agent.id === BOOKING_AGENT_ID) {
      reply = finalizeBookingAi({
        state,
        agentMessages,
        reply,
        chatOther,
        consumeServiceChangeNotice,
        confirmationCleanup,
      });
    } else if (agent.id === FAQ_AGENT_ID) {
      reply = await finalizeFaqAi({
        state,
        agentMessages,
        reply,
        rawText,
        yieldTag,
        confirmationCleanup,
        ...(options != null ? { options } : {}),
      });
    } else {
      reply = {
        ...reply,
        patch: {
          ...confirmationCleanup,
          supervisorIntent: null,
          ...reply.patch,
        },
      };
    }

    const blockedConfirmationMutation =
      hasMutationCallDuringUnresolvedConfirmation(state);

    const replyMessage =
      reply.replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || reply.replySource === "runtime"
        || blockedConfirmationMutation
        ? new AIMessage({
            content: reply.replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    return assembleFinalize({
      agent,
      extras: { ...cleared, ...reply.patch },
      reply,
      replyMessage,
    });
  };

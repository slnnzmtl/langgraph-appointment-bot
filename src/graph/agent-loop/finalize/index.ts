import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, Overwrite } from "@langchain/langgraph";
import {
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../../types.js";
import {
  PATIENT_FALLBACK_MESSAGE,
} from "../../../shared/clinic-constants.js";
import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractReplyButtons,
} from "../../../shared/message-content.js";
import { clearPendingConfirmForRuntime } from "../../../tools/meeting-confirm.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { isModelFailureMessage, tagRuntimeAgentMessage } from "../../sub-agent-messages.js";
import {
  applyMutationChatOtherCleanup,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
} from "../mutation-chat-other.js";
import {
  createAgentMutationFinalizeNode,
} from "../mutation-finalize.js";
import {
  mutationCommittedThisTurn,
  terminalMeetingMutationOutcome,
} from "../protocol/index.js";
import {
  applyFaqCatalogAiFinalize,
  tryFaqNoAiFinalize,
  type FinalizeFaqOptions,
} from "./faq.js";
import {
  applyFalseSuccessClaimOverride,
  applyServiceOfferSynthesis,
  emptyFinalizeReply,
  finalizeAiUpdate,
  lastHandoffFromReply,
  offeredServiceForTurn,
  resolveHandoffStatus,
  type FinalizeReply,
} from "./shared.js";

/** Re-export for existing tests that import from finalize.js. */
export { offeredServiceForTurn };

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

/** Clear agent tape after finalize ships a handoff. */
const clearedAgentTape = (): ClinicStateUpdate => ({
  agentMessages: new Overwrite([] as BaseMessage[]),
  stepCount: 0,
});

type FinalizeSpecialist = {
  tryNoAi: (
    state: ClinicState,
    agentMessages: BaseMessage[],
  ) => FinalizeReply | null;
  finalizeAi: (input: {
    state: ClinicState;
    agentMessages: BaseMessage[];
    reply: FinalizeReply;
    rawText: string;
    yieldTag: boolean;
    chatOther: boolean;
    confirmationCleanup: ClinicStateUpdate;
    consumeServiceChangeNotice: () => string | null;
  }) => FinalizeReply | Promise<FinalizeReply>;
  modelFailureButtons: (state: ClinicState) => string[] | undefined;
};

const createSpecialistFinalizeNode = (
  agent: ClinicAgentDefinition,
  specialist: FinalizeSpecialist,
) =>
  async (
    state: ClinicState,
    config?: RunnableConfig,
  ): Promise<ClinicStateUpdate | Command> => {
    const agentMessages = state.agentMessages ?? [];
    // REPLACE cancel already opened the FAQ catalog — do not treat the cancel
    // ToolMessage as a terminal mutation finalize that closes the session.
    const faqCatalogOpenAfterReplaceCancel =
      state.pendingInteraction?.kind === "service_candidate"
      && state.pendingInteraction.owner === "faq"
      && state.pendingInteraction.consultationDeclined === true;
    if (
      terminalMeetingMutationOutcome(state) != null
      && !faqCatalogOpenAfterReplaceCancel
    ) {
      return createAgentMutationFinalizeNode(agent)(state, config);
    }
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = clearedAgentTape();
    const chatOther = hasPendingConfirmationChatOther(state);
    const confirmationCleanup = chatOther
      ? applyMutationChatOtherCleanup(state)
      : {};
    if (chatOther) {
      clearPendingConfirmForRuntime(config);
    }

    if (!(lastMessage instanceof AIMessage)) {
      const noAi = specialist.tryNoAi(state, agentMessages);
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

    const consumeServiceChangeNotice = (): string | null => null;

    if (status === "error" && isModelFailureMessage(tagged)) {
      const failureButtons = specialist.modelFailureButtons(state);
      reply = {
        ...emptyFinalizeReply("error"),
        replyText: PATIENT_FALLBACK_MESSAGE,
        ...(failureButtons != null ? { replyButtons: failureButtons } : {}),
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

    reply = await specialist.finalizeAi({
      state,
      agentMessages,
      reply,
      rawText,
      yieldTag,
      chatOther,
      confirmationCleanup,
      consumeServiceChangeNotice,
    });

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

    return finalizeAiUpdate({
      agent,
      extras: { ...cleared, ...reply.patch },
      reply,
      replyMessage,
    });
  };

export const createFaqFinalizeNode = (
  agent: ClinicAgentDefinition,
  options?: FinalizeFaqOptions,
) =>
  createSpecialistFinalizeNode(agent, {
    tryNoAi: (state) => tryFaqNoAiFinalize(state),
    finalizeAi: (input) => finalizeFaqAi({
      state: input.state,
      agentMessages: input.agentMessages,
      reply: input.reply,
      rawText: input.rawText,
      yieldTag: input.yieldTag,
      confirmationCleanup: input.confirmationCleanup,
      ...(options != null ? { options } : {}),
    }),
    modelFailureButtons: () => undefined,
  });

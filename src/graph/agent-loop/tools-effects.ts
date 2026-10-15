import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import {
  bookingOfferLabels,
  inferConversationLocaleFromText,
} from "../../shared/conversation-locale.js";
import {
  consultationService,
  reduceBookingSession,
} from "../booking-session.js";
import type { PartitionServiceCandidates } from "../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  crmWriteDirtiesPrefetch,
  lastPatientText,
} from "./protocol.js";
import { type ToolProtocolResult } from "./tools-protocol.js";
import { projectAvailabilityEffects } from "./tools-effects-availability.js";
import { projectContactEffects } from "./tools-effects-contact.js";
import { projectMutationEffects } from "./tools-effects-mutation.js";
import { projectServiceEffects } from "./tools-effects-service.js";

export type CreateAgentToolsOptions = {
  partitionCandidates?: PartitionServiceCandidates;
};

/** Next-projection state: omitted keys stay; explicit null overwrites. */
const applyEffective = (
  effective: ClinicState,
  patch: ClinicStateUpdate,
): ClinicState => {
  const next: ClinicState = { ...effective };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
};

export const applyToolEffects = async (
  state: ClinicState,
  protocol: ToolProtocolResult,
  toolResultMessages: BaseMessage[],
  options?: CreateAgentToolsOptions & { listServicesTool?: StructuredToolInterface },
): Promise<ClinicStateUpdate> => {
  if (protocol.stateTapeRewrite != null) {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(protocol.stateTapeRewrite),
    };
    if (protocol.recovery?.type === "service_confirmation_required") {
      const labels = bookingOfferLabels(
        inferConversationLocaleFromText(lastPatientText(state)),
      );
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        {
          type: "service_offered",
          service: consultationService("catalog"),
          acceptLabel: labels.acceptLabel,
          chooseOtherLabel: labels.chooseOtherLabel,
        },
      );
      update.bookingDraft = session.bookingDraft;
      update.pendingInteraction = session.pendingInteraction;
    } else if (protocol.recovery?.type === "contact_field_required") {
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        {
          type: "contact_field_required",
          field: protocol.recovery.field,
          ...(protocol.recovery.occupied === true ? { occupied: true } : {}),
        },
      );
      update.pendingInteraction = session.pendingInteraction;
    }
    return update;
  }

  const synthetic = protocol.syntheticMessages;
  const resultMessages = [...synthetic, ...toolResultMessages];
  const replacementCancellationResult =
    state.bookingDraft?.replacement?.status === "cancelling"
    && resultMessages.some(
      (message) => message instanceof ToolMessage && message.name === "cancel_meeting",
    );

  let effectiveState = state;
  let update: ClinicStateUpdate = {
    agentMessages: resultMessages,
    ...(replacementCancellationResult
      ? { pendingCancellationPurpose: "replacement" as const }
      : {}),
  };
  if (replacementCancellationResult) {
    effectiveState = applyEffective(effectiveState, {
      pendingCancellationPurpose: "replacement",
    });
  }

  const mutation = await projectMutationEffects({
    state: effectiveState,
    resultMessages,
    options: {
      ...(options?.partitionCandidates != null
        ? { partitionCandidates: options.partitionCandidates }
        : {}),
      ...(options?.listServicesTool != null
        ? { listServicesTool: options.listServicesTool }
        : {}),
    },
  });
  update = { ...update, ...mutation.patch };
  effectiveState = applyEffective(effectiveState, mutation.patch);

  if (!mutation.skipAvailability) {
    const availability = projectAvailabilityEffects({
      state: effectiveState,
      resultMessages,
    });
    update = { ...update, ...availability };
    effectiveState = applyEffective(effectiveState, availability);
  }

  const services = projectServiceEffects({ resultMessages });
  update = { ...update, ...services };
  effectiveState = applyEffective(effectiveState, services);

  const contact = projectContactEffects({
    state: effectiveState,
    resultMessages,
  });
  update = { ...update, ...contact };
  effectiveState = applyEffective(effectiveState, contact);

  if (crmWriteDirtiesPrefetch(resultMessages)) {
    update = { ...update, prefetchDirty: true };
  }

  return update;
};

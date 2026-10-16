import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import type { PartitionServiceCandidates } from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  crmWriteDirtiesPrefetch,
  meetingMutationClearsAvailability,
} from "../protocol.js";
import { type ToolProtocolResult } from "../tools-protocol.js";
import { applyAvailabilityToolEffects } from "./availability.js";
import {
  applyAuthFailureContactClear,
  applyContactFieldRequiredRecovery,
  applyContactProjection,
} from "./contact.js";
import { applyMutationToolEffects } from "./mutation.js";
import {
  applyCapturedServices,
  applyServiceConfirmationRecovery,
} from "./service.js";

export type CreateAgentToolsOptions = {
  partitionCandidates?: PartitionServiceCandidates;
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
      applyServiceConfirmationRecovery(state, update);
    } else if (protocol.recovery?.type === "contact_field_required") {
      applyContactFieldRequiredRecovery(state, protocol, update);
    }
    return update;
  }

  const listServicesTool = options?.listServicesTool;
  const synthetic = protocol.syntheticMessages;
  const resultMessages = [...synthetic, ...toolResultMessages];
  const update: ClinicStateUpdate = {
    agentMessages: resultMessages,
  };

  const authorizationFailure = applyAuthFailureContactClear(state, resultMessages, update);

  await applyMutationToolEffects(state, resultMessages, update, {
    ...(options?.partitionCandidates != null
      ? { partitionCandidates: options.partitionCandidates }
      : {}),
    ...(listServicesTool != null ? { listServicesTool } : {}),
  });

  if (!meetingMutationClearsAvailability(resultMessages)) {
    applyAvailabilityToolEffects(state, resultMessages, update);
  }

  applyCapturedServices(resultMessages, update);
  applyContactProjection(state, resultMessages, update, authorizationFailure);

  if (crmWriteDirtiesPrefetch(resultMessages)) {
    update.prefetchDirty = true;
  }

  return update;
};

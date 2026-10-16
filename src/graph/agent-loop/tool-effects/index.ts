import type { BaseMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { crmWriteDirtiesPrefetch } from "../protocol.js";
import { type ToolProtocolResult } from "../tools-protocol.js";
import { projectAvailabilityEffects } from "./availability.js";
import { projectContactEffects } from "./contact.js";
import { projectMutationEffects } from "./mutation.js";
import { projectServiceEffects } from "./service.js";

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

export const applyToolEffects = (
  state: ClinicState,
  protocol: ToolProtocolResult,
  toolResultMessages: BaseMessage[],
): ClinicStateUpdate => {
  if (protocol.stateTapeRewrite != null) {
    return {
      agentMessages: new Overwrite(protocol.stateTapeRewrite),
    };
  }

  const resultMessages = [...protocol.syntheticMessages, ...toolResultMessages];

  let effectiveState = state;
  // Keep resultMessages on the return update only — contact projection must
  // resolve tool-call args against the original agentMessages tape.
  let update: ClinicStateUpdate = {
    agentMessages: resultMessages,
  };

  const mutation = projectMutationEffects({
    state: effectiveState,
    resultMessages,
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

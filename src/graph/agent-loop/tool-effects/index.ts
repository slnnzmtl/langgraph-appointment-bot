import type { BaseMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { BOOKING_AGENT_ID, type ClinicAgentId } from "../../types.js";
import { crmWriteDirtiesPrefetch, meetingMutationClearsAvailability } from "../protocol/index.js";
import { type ToolProtocolResult } from "../tools-protocol.js";
import {
  captureAvailabilityReadModel,
  projectAvailabilityEffects,
} from "./availability.js";
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

/**
 * FAQ keeps full session/draft projections.
 * Booking only stamps read models (availability/services/contact context) —
 * decideBooking owns draft + pendingInteraction via EffectResult.
 */
export const applyToolEffects = (
  state: ClinicState,
  protocol: ToolProtocolResult,
  toolResultMessages: BaseMessage[],
  agentId: ClinicAgentId = "faq",
): ClinicStateUpdate => {
  const resultMessages = toolResultMessages;
  const bookingPath = agentId === BOOKING_AGENT_ID;

  let effectiveState = state;
  let update: ClinicStateUpdate = {
    agentMessages: protocol.stateTapeRewrite != null
      ? new Overwrite([...protocol.stateTapeRewrite, ...resultMessages])
      : resultMessages,
  };

  if (bookingPath) {
    if (meetingMutationClearsAvailability(resultMessages)) {
      update = {
        ...update,
        availabilityContext: null,
        availabilityCursor: null,
      };
      effectiveState = applyEffective(effectiveState, {
        availabilityContext: null,
        availabilityCursor: null,
      });
    } else {
      const availability = captureAvailabilityReadModel({
        state: effectiveState,
        resultMessages,
      });
      update = { ...update, ...availability };
      effectiveState = applyEffective(effectiveState, availability);
    }

    const services = projectServiceEffects({ resultMessages });
    update = { ...update, ...services };
    effectiveState = applyEffective(effectiveState, services);

    // Contact CRM rows for supervisor/prefetch — decide owns draft events.
    const contact = projectContactEffects({
      state: effectiveState,
      resultMessages,
      includeDraftEvents: false,
    });
    update = { ...update, ...contact };
    effectiveState = applyEffective(effectiveState, contact);

    if (crmWriteDirtiesPrefetch(resultMessages)) {
      update = { ...update, prefetchDirty: true };
    }
    return update;
  }

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

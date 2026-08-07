import { AIMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  normalizeDelegationPrompt,
  normalizeSupervisorReply,
  type ClinicRoutingDecision,
  buildClinicRoutingSchema,
} from "./routing.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import { stripToolsForSupervisor } from "./supervisor-history.js";
import {
  FINISH_ROUTE,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "./types.js";

export type CreateClinicSupervisorNodeOptions = {
  agents: ClinicAgentDefinition[];
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
};

const routingFailureUpdate = (_reason: string): ClinicStateUpdate => ({
  next: FINISH_ROUTE,
  lastHandoff: null,
  delegationPrompt: null,
  messages: [
    new AIMessage(
      "Sorry, I could not route that request. Please try again in a moment.",
    ),
  ],
});

export const createClinicSupervisorNode = (options: CreateClinicSupervisorNodeOptions) => {
  const schema = buildClinicRoutingSchema(options.agents);
  const enabledIds = new Set(options.agents.map((agent) => agent.id));

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const staticPrompt = options.loadSupervisorPrompt().trim();
    const dynamic = options.buildSupervisorDynamicContext?.().trim() ?? "";
    const systemText =
      dynamic.length > 0 ? `${staticPrompt}\n\n${dynamic}` : staticPrompt;

    let decision: ClinicRoutingDecision;
    try {
      decision = (await options.supervisorLlm
        .bindRoutingTools(schema)
        .invoke(
          [new SystemMessage(systemText), ...stripToolsForSupervisor(state.messages)],
          config,
        )) as ClinicRoutingDecision;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[clinic-supervisor] routing failed:", message);
      return routingFailureUpdate(message);
    }

    if (decision.next === FINISH_ROUTE) {
      const reply = normalizeSupervisorReply(decision.reply);
      if (!reply) {
        // After a specialist handoff with visible AI text, finish without re-asking.
        const last = state.messages[state.messages.length - 1];
        if (last instanceof AIMessage && state.lastHandoff) {
          return {
            next: FINISH_ROUTE,
            lastHandoff: null,
            delegationPrompt: null,
          };
        }
        return routingFailureUpdate("FINISH without reply");
      }

      return {
        next: FINISH_ROUTE,
        lastHandoff: null,
        delegationPrompt: null,
        messages: [new AIMessage(reply)],
      };
    }

    if (!enabledIds.has(decision.next)) {
      return routingFailureUpdate(`Unknown route: ${decision.next}`);
    }

    const prompt = normalizeDelegationPrompt(decision.prompt);
    if (!prompt) {
      return routingFailureUpdate(`Missing delegation prompt for ${decision.next}`);
    }

    return {
      next: decision.next,
      delegationPrompt: prompt,
      lastHandoff: null,
    };
  };
};

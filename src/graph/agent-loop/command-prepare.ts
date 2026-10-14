import { Command } from "@langchain/langgraph";

import { BOOKING_AGENT_ID } from "../types.js";
import type { ClinicState } from "../state.js";
import {
  finalizeNodeName,
  llmNodeName,
  toolsNodeName,
} from "./nodes-names.js";
import { interactionRenderNodeName } from "../booking-note-orchestrator.js";
import {
  resolveBookingCommand,
  type BookingCommandOutcome,
} from "./booking-command.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";

export type CommandPrepareNodes = {
  tools: string;
  interactionRender: string;
  llm: string;
  finalize: string;
};

export const defaultCommandPrepareNodes = (agentId: string): CommandPrepareNodes => ({
  tools: toolsNodeName(agentId),
  interactionRender: interactionRenderNodeName(agentId),
  llm: llmNodeName(agentId),
  finalize: finalizeNodeName(agentId),
});

/**
 * Map a pure booking outcome to a LangGraph Command. Does not store the outcome
 * on checkpoint state — only the update payload and the goto target.
 */
export const commandFromBookingOutcome = (
  state: ClinicState,
  outcome: BookingCommandOutcome,
  nodes: CommandPrepareNodes,
): Command => {
  if (outcome.kind === "execute") {
    return new Command({
      update: outcome.update,
      goto: nodes.tools,
    });
  }
  if (outcome.kind === "render") {
    return new Command({
      update: outcome.update,
      goto: nodes.interactionRender,
    });
  }
  const update = outcome.update ?? {};
  const pendingInformational =
    hasPendingToolCalls(state.agentMessages)
    || lastMessageRequestsTools(state.agentMessages);
  return new Command({
    update,
    goto: pendingInformational ? nodes.tools : nodes.llm,
  });
};

/**
 * Checkpoint the normalized mutation command before ToolNode can reach HITL.
 * LangGraph does not apply a node's return value when a later node interrupts,
 * so preparing this in the tools node is too late for restart-safe confirmation.
 */
export const createAgentCommandPrepareNode = (
  agentId: string,
  nodes: CommandPrepareNodes = defaultCommandPrepareNodes(agentId),
) =>
  async (state: ClinicState): Promise<Command> => {
    if (agentId !== BOOKING_AGENT_ID) {
      return new Command({ update: {}, goto: nodes.llm });
    }
    return commandFromBookingOutcome(state, resolveBookingCommand(state), nodes);
  };

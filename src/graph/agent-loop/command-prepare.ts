import { Command, Overwrite } from "@langchain/langgraph";

import { trackEvent } from "../../analytics/track.js";
import { BOOKING_AGENT_ID } from "../types.js";
import type { ClinicState } from "../state.js";
import {
  finalizeNodeName,
  llmNodeName,
  toolsNodeName,
} from "./nodes-names.js";
import { interactionRenderNodeName } from "../booking-note-orchestrator.js";
import {
  authoritativeNoteStatus,
  resolveBookingCommand,
  type BookingCommandOutcome,
} from "./booking-command.js";
import {
  appendOrReplacePendingToolCall,
  stampRuntimeToolAi,
} from "./runtime-tool-stamp.js";

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

const emitRenderTelemetry = (
  state: ClinicState,
  outcome: Extract<BookingCommandOutcome, { kind: "render" }>,
): void => {
  if (outcome.reason === "stale_slot") {
    trackEvent("booking_invariant_violation", { reason: "stale_slot" });
    return;
  }
  if (outcome.reason === "note_required") {
    trackEvent("booking_create_blocked_note", {
      phase: authoritativeNoteStatus(state),
    });
    return;
  }
  if (
    outcome.reason === "consultation_agreement"
    && outcome.update.pendingInteraction != null
  ) {
    trackEvent("booking_consultation_guard", {
      phase: state.bookingDraft?.phase ?? "service",
      outcome: "render",
    });
  }
};

/**
 * Map a pure booking outcome to a LangGraph Command. Stamps runtime tool calls
 * and emits telemetry exactly once. Does not store the outcome on checkpoint
 * state — only the update payload and the goto target.
 */
export const commandFromBookingOutcome = (
  state: ClinicState,
  outcome: BookingCommandOutcome,
  nodes: CommandPrepareNodes,
): Command => {
  if (outcome.kind === "execute") {
    const stamped = stampRuntimeToolAi(
      outcome.toolCall.name,
      [{
        id: outcome.toolCall.id,
        name: outcome.toolCall.name,
        args: outcome.toolCall.args,
        type: "tool_call" as const,
      }],
      outcome.toolCall.action,
    );
    return new Command({
      update: {
        ...outcome.update,
        agentMessages: new Overwrite(
          appendOrReplacePendingToolCall(state.agentMessages ?? [], stamped),
        ),
      },
      goto: nodes.tools,
    });
  }
  if (outcome.kind === "render") {
    emitRenderTelemetry(state, outcome);
    return new Command({
      update: outcome.update,
      goto: nodes.interactionRender,
    });
  }
  if (outcome.kind === "continue_tools") {
    return new Command({
      update: outcome.update ?? {},
      goto: nodes.tools,
    });
  }
  if (outcome.kind === "finalize" || outcome.kind === "noop") {
    return new Command({
      update: outcome.kind === "finalize" ? (outcome.update ?? {}) : {},
      goto: nodes.finalize,
    });
  }
  return new Command({
    update: outcome.update ?? {},
    goto: nodes.llm,
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

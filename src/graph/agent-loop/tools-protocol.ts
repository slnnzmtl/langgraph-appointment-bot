import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { trackToolError } from "../../analytics/track.js";
import {
  BOOKING_INFORMATIONAL_TOOL_NAMES,
  isBookingRuntimeToolName,
} from "../../tools/index.js";
import type { ClinicState } from "../state.js";
import { BOOKING_AGENT_ID } from "../types.js";
import {
  isRuntimeOriginatedToolAi,
  rewriteAiToolCalls,
} from "./runtime-tool-stamp.js";

export type ToolProtocolResult = {
  messagesForTools: BaseMessage[];
  /** Always empty — invariants live in planner / CRM / tool schemas. */
  syntheticMessages: [];
  stateTapeRewrite?: BaseMessage[];
  recovery: null;
};

/**
 * Stamp + allowlist gate before ToolNode.
 * Drop unstamped booking runtime calls; keep stamped runtime and tools bound
 * on this agent. Planner / CRM tools own readiness and authorization.
 */
export const filterToolTape = (
  state: ClinicState,
  agentId?: string,
  allowedToolNames?: ReadonlySet<string>,
): ToolProtocolResult => {
  const agentMessages = state.agentMessages ?? [];
  let lastAiIndex = -1;
  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const message = agentMessages[index];
    if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
      lastAiIndex = index;
      break;
    }
  }

  const remainingCalls: NonNullable<AIMessage["tool_calls"]> = [];
  let strippedUnstampedRuntime = false;

  if (lastAiIndex >= 0) {
    const lastAi = agentMessages[lastAiIndex] as AIMessage;
    const runtimeOriginOk = agentId === BOOKING_AGENT_ID
      ? isRuntimeOriginatedToolAi(lastAi)
      : true;

    for (const call of lastAi.tool_calls ?? []) {
      if (isBookingRuntimeToolName(call.name)) {
        if (agentId === BOOKING_AGENT_ID && !runtimeOriginOk) {
          trackToolError(call.name, "unstamped_runtime_tool");
          strippedUnstampedRuntime = true;
          continue;
        }
        remainingCalls.push(call);
        continue;
      }

      const allowlisted = allowedToolNames != null
        ? allowedToolNames.has(call.name)
        : agentId === BOOKING_AGENT_ID
          ? BOOKING_INFORMATIONAL_TOOL_NAMES.has(call.name)
          : true;
      if (!allowlisted) {
        trackToolError(call.name, "disallowed_tool_call");
        continue;
      }
      remainingCalls.push(call);
    }

    // Drop unstamped runtime calls from the AI message so the tape stays
    // protocol-valid without synthetic invariant ToolMessages.
    if (strippedUnstampedRuntime && remainingCalls.length === 0) {
      const kept = (lastAi.tool_calls ?? []).filter(
        (call) => !isBookingRuntimeToolName(call.name),
      );
      const rewritten = [
        ...agentMessages.slice(0, lastAiIndex),
        new AIMessage({
          content: lastAi.content,
          tool_calls: kept,
          additional_kwargs: lastAi.additional_kwargs,
          response_metadata: lastAi.response_metadata,
          id: lastAi.id,
        } as ConstructorParameters<typeof AIMessage>[0]),
        ...agentMessages.slice(lastAiIndex + 1),
      ];
      return {
        messagesForTools: rewritten,
        syntheticMessages: [],
        stateTapeRewrite: rewritten,
        recovery: null,
      };
    }
  }

  return {
    messagesForTools: rewriteAiToolCalls(agentMessages, lastAiIndex, remainingCalls),
    syntheticMessages: [],
    recovery: null,
  };
};

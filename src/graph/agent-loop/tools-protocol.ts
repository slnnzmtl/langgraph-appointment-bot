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
  stateTapeRewrite?: BaseMessage[];
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

  if (lastAiIndex < 0) {
    return { messagesForTools: agentMessages };
  }

  const lastAi = agentMessages[lastAiIndex] as AIMessage;
  const originalCalls = lastAi.tool_calls ?? [];
  const runtimeOriginOk = agentId === BOOKING_AGENT_ID
    ? isRuntimeOriginatedToolAi(lastAi)
    : true;

  for (const call of originalCalls) {
    if (isBookingRuntimeToolName(call.name)) {
      if (agentId === BOOKING_AGENT_ID && !runtimeOriginOk) {
        trackToolError(call.name, "unstamped_runtime_tool");
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

  const rewritten = rewriteAiToolCalls(agentMessages, lastAiIndex, remainingCalls);
  const callsChanged = remainingCalls.length !== originalCalls.length;
  return {
    messagesForTools: rewritten,
    ...(callsChanged ? { stateTapeRewrite: rewritten } : {}),
  };
};

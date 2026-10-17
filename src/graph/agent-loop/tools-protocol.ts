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
 * Allowlist + stamp gate before ToolNode.
 * Require every call in the node's bound-tool set first; then drop unstamped
 * booking runtime calls. Planner / CRM tools own readiness and authorization.
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
    // Bound allowlist first; runtime-origin stamp is a second gate only.
    const allowlisted = allowedToolNames != null
      ? allowedToolNames.has(call.name)
      : agentId === BOOKING_AGENT_ID
        ? BOOKING_INFORMATIONAL_TOOL_NAMES.has(call.name)
          || isBookingRuntimeToolName(call.name)
        : true;
    if (!allowlisted) {
      trackToolError(call.name, "disallowed_tool_call");
      continue;
    }
    if (
      isBookingRuntimeToolName(call.name)
      && agentId === BOOKING_AGENT_ID
      && !runtimeOriginOk
    ) {
      trackToolError(call.name, "unstamped_runtime_tool");
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

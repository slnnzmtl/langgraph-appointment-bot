import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import type { ClinicState, ClinicStateUpdate } from "../state.js";
import type { ClinicAgentId } from "../types.js";
import { findLastAIMessage } from "../tool-routing.js";
import { applyToolEffects } from "./tool-effects/index.js";
import { toolMessagesFromToolNodeInvoke } from "./tool-node-result.js";
import { filterToolTape } from "./tools-protocol.js";

export const createAgentToolsNode = (
  tools: StructuredToolInterface[],
  agentId: ClinicAgentId,
) => {
  // Expected CRM/domain failures return structured `{ error }` JSON from the
  // tool implementations. Unexpected throws must not become ToolMessages.
  const toolNode = new ToolNode(tools, { handleToolErrors: false });
  const allowedToolNames = new Set(tools.map((entry) => entry.name));

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const protocol = filterToolTape(state, agentId, allowedToolNames);

    let toolResultMessages: BaseMessage[] = [];
    // Executable AI may sit mid-tape with trailing ToolMessages after rewriteAiToolCalls.
    const lastAi = findLastAIMessage(protocol.messagesForTools);
    const hasCalls = (lastAi?.tool_calls?.length ?? 0) > 0;
    if (hasCalls) {
      const result = await toolNode.invoke(
        { messages: protocol.messagesForTools },
        {
          ...config,
          configurable: {
            ...config?.configurable,
            availabilityContext: state.availabilityContext ?? null,
          },
        },
      );
      toolResultMessages = toolMessagesFromToolNodeInvoke(result);
    }

    return applyToolEffects(state, protocol, toolResultMessages);
  };
};

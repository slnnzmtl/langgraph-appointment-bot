import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { findLastAIMessage } from "../tool-routing.js";
import {
  applyToolEffects,
  type CreateAgentToolsOptions,
} from "./tool-effects/index.js";
import { filterToolTape } from "./tools-protocol.js";

export type { CreateAgentToolsOptions };

export const createAgentToolsNode = (
  tools: StructuredToolInterface[],
  agentId?: string,
  options?: CreateAgentToolsOptions,
) => {
  const toolNode = new ToolNode(tools);
  const listServicesTool = tools.find((entry) => entry.name === "list_services");

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const protocol = filterToolTape(state, agentId);
    if (protocol.stateTapeRewrite != null) {
      return applyToolEffects(state, protocol, [], {
        ...options,
        ...(listServicesTool != null ? { listServicesTool } : {}),
      });
    }

    let toolResultMessages: BaseMessage[] = [];
    // Executable AI may sit mid-tape with trailing ToolMessages after rewriteAiToolCalls.
    const lastAi = findLastAIMessage(protocol.messagesForTools);
    const hasCalls = (lastAi?.tool_calls?.length ?? 0) > 0;
    if (hasCalls) {
      const result = await (
        toolNode as unknown as {
          run(
            input: { messages: BaseMessage[] },
            config?: RunnableConfig,
          ): Promise<{ messages: BaseMessage[] }>;
        }
      ).run({ messages: protocol.messagesForTools }, config);
      toolResultMessages = result.messages;
    }

    return applyToolEffects(state, protocol, toolResultMessages, {
      ...options,
      ...(listServicesTool != null ? { listServicesTool } : {}),
    });
  };
};

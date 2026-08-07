import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { extractMessageTextContent } from "../shared/message-content.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import {
  applyDelegationPrompt,
  scopeSubAgentMessages,
  tagRuntimeAgentMessage,
} from "./sub-agent-messages.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "./tool-routing.js";
import type { ClinicAgentDefinition, ClinicHandoffStatus } from "./types.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;
export const llmNodeName = (agentId: string): string => `${agentId}__llm`;
export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;
export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

export type CreateAgentLoopOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
};

const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

export const createAgentPrepareNode = (agentId: string) =>
  (state: ClinicState): ClinicStateUpdate => {
    const scoped = scopeSubAgentMessages(state.messages, agentId);
    const delegationPrompt = state.delegationPrompt?.trim();
    const agentMessages = delegationPrompt
      ? applyDelegationPrompt(scoped, delegationPrompt)
      : scoped;

    return {
      agentMessages: new Overwrite(agentMessages),
      stepCount: 0,
    };
  };

export const createAgentLlmNode = (options: CreateAgentLoopOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    if (hasPendingToolCalls(state.agentMessages)) {
      return { stepCount: state.stepCount };
    }

    const last = state.agentMessages[state.agentMessages.length - 1];
    const isContinuation = last instanceof ToolMessage;
    const stepCount = isContinuation ? state.stepCount + 1 : 1;

    const system = [
      agent.systemPrompt.trim(),
      formatSystemMetadata(new Date(), { runtimeAgent: agent.name }),
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const response = await boundModel.invoke(
        [new SystemMessage(system), ...state.agentMessages],
        config,
      );
      return {
        agentMessages: [response as AIMessage],
        stepCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        agentMessages: [
          new AIMessage(`Unable to run ${agent.name}: ${message}`),
        ],
        stepCount,
      };
    }
  };
};

export const createAgentToolsNode = (tools: StructuredToolInterface[]) => {
  const toolNode = new ToolNode(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const result = await (
      toolNode as unknown as {
        run(
          input: { messages: BaseMessage[] },
          config?: RunnableConfig,
        ): Promise<{ messages: BaseMessage[] }>;
      }
    ).run({ messages: state.agentMessages }, config);

    return { agentMessages: result.messages };
  };
};

export const createAgentFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState): ClinicStateUpdate => {
    const agentMessages = state.agentMessages ?? [];
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
      delegationPrompt: null,
    };

    if (!(lastMessage instanceof AIMessage)) {
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
    };

    if (status === "empty") {
      return { ...cleared, lastHandoff };
    }

    if (status === "max_steps") {
      const text = extractMessageTextContent(tagged.content).trim();
      const message =
        text.length > 0
          ? tagged
          : new AIMessage(
              `Unable to complete ${agent.name}: exceeded the maximum of ${agent.maxSteps} tool steps.`,
            );
      return {
        ...cleared,
        lastHandoff,
        messages: [
          message instanceof AIMessage
            ? tagRuntimeAgentMessage(message, agent.id)
            : message,
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
      messages: [tagged],
    };
  };

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
): string => {
  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  return llmName;
};

import { randomUUID } from "node:crypto";

import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
} from "@personal-assistant/llm-gemini";

import { extractMessageTextContent } from "../shared/message-content.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import {
  applyDelegationPrompt,
  scopeSubAgentMessages,
  tagRuntimeAgentMessage,
} from "./sub-agent-messages.js";
import type { SupervisorContextCacheOptions } from "./supervisor.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "./tool-routing.js";
import type { ClinicAgentDefinition, ClinicHandoffStatus } from "./types.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;
export const llmNodeName = (agentId: string): string => `${agentId}__llm`;
export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;
export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

export const FIND_CONTACT_BY_TELEGRAM_TOOL = "find_contact_by_telegram" as const;
export const LIST_SERVICES_TOOL = "list_services" as const;

export type CreateAgentLoopOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  contextCache?: SupervisorContextCacheOptions;
};

export type AgentPrepareOptions = {
  prefetch?: (scoped: BaseMessage[]) => Promise<BaseMessage[]>;
};

/** Synthetic fulfilled tool exchange so booking LLM starts with prefetched tool context. */
export const buildPrefetchedToolMessages = (
  toolName: string,
  result: string,
): BaseMessage[] => {
  const toolCallId = `prefetch-${toolName}-${randomUUID()}`;
  return [
    new AIMessage({
      content: "",
      tool_calls: [
        {
          id: toolCallId,
          name: toolName,
          args: {},
        },
      ],
    }),
    new ToolMessage({
      content: result,
      tool_call_id: toolCallId,
      name: toolName,
    }),
  ];
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

export const createAgentPrepareNode = (agentId: string, options?: AgentPrepareOptions) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const scoped = scopeSubAgentMessages(state.messages, agentId);
    const delegationPrompt = state.delegationPrompt?.trim();
    let agentMessages = delegationPrompt
      ? applyDelegationPrompt(scoped, delegationPrompt)
      : scoped;

    if (options?.prefetch) {
      const prefetched = await options.prefetch(agentMessages);
      agentMessages = [...agentMessages, ...prefetched];
    }

    return {
      agentMessages: new Overwrite(agentMessages),
      stepCount: 0,
    };
  };

export const createAgentLlmNode = (options: CreateAgentLoopOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;
  const cache = options.contextCache;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);
  const displayName = cache?.displayName ?? `clinic-${agent.id}`;

  const invokeUncached = async (
    staticPrompt: string,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) =>
    boundModel.invoke(buildUncachedMessages(staticPrompt, dynamic, history), config);

  const invokeCached = async (
    handle: ContextCacheHandle,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) => {
    const cachedModel = createCachedGeminiModel(cache!.apiKey, cache!.modelName, handle);
    // Tools and system instruction live in CachedContent — must not be sent again on generateContent.
    return cachedModel.invoke(buildCachedMessages(dynamic, history), config);
  };

  const cacheSpec = (staticPrompt: string) => ({
    modelName: cache!.modelName,
    staticSystemInstruction: staticPrompt,
    tools,
    displayName,
  });

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    if (hasPendingToolCalls(state.agentMessages)) {
      return { stepCount: state.stepCount };
    }

    const last = state.agentMessages[state.agentMessages.length - 1];
    const isContinuation = last instanceof ToolMessage;
    const stepCount = isContinuation ? state.stepCount + 1 : 1;

    const staticPrompt = agent.systemPrompt.trim();
    const dynamic = formatSystemMetadata(new Date(), { runtimeAgent: agent.name }).trim();

    try {
      let handle: ContextCacheHandle | null = null;
      if (cache) {
        handle = await cache.manager.getOrCreate(cacheSpec(staticPrompt));
      }

      let response: AIMessage;
      if (handle) {
        try {
          response = (await invokeCached(
            handle,
            dynamic,
            state.agentMessages,
            config,
          )) as AIMessage;
        } catch (error) {
          if (!isCachedContentNotFoundError(error)) {
            throw error;
          }
          cache!.manager.invalidate(handle.cacheName);
          const recreated = await cache!.manager.getOrCreate(cacheSpec(staticPrompt));
          response = (recreated
            ? await invokeCached(recreated, dynamic, state.agentMessages, config)
            : await invokeUncached(staticPrompt, dynamic, state.agentMessages, config)) as AIMessage;
        }
      } else {
        response = (await invokeUncached(
          staticPrompt,
          dynamic,
          state.agentMessages,
          config,
        )) as AIMessage;
      }

      return {
        agentMessages: [response],
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

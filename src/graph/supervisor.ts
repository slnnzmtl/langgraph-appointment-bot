import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
  type ContextCacheManager,
} from "@personal-assistant/llm-gemini";

import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
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

export type SupervisorContextCacheOptions = {
  manager: ContextCacheManager;
  apiKey: string;
  modelName: string;
  displayName?: string;
};

export type CreateClinicSupervisorNodeOptions = {
  agents: ClinicAgentDefinition[];
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
  contextCache?: SupervisorContextCacheOptions;
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

const resolveRoutingDecision = (
  decision: ClinicRoutingDecision,
  state: ClinicState,
  enabledIds: Set<string>,
): ClinicStateUpdate => {
  if (decision.next === FINISH_ROUTE) {
    const reply = normalizeSupervisorReply(decision.reply);
    if (!reply) {
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

export const createClinicSupervisorNode = (options: CreateClinicSupervisorNodeOptions) => {
  const schema = buildClinicRoutingSchema(options.agents);
  const enabledIds = new Set(options.agents.map((agent) => agent.id));
  const cache = options.contextCache;

  const invokeUncached = async (
    staticPrompt: string,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ): Promise<ClinicRoutingDecision> =>
    (await options.supervisorLlm.bindRoutingTools(schema).invoke(
      buildUncachedMessages(staticPrompt, dynamic, history),
      config,
    )) as ClinicRoutingDecision;

  const invokeCached = async (
    handle: ContextCacheHandle,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ): Promise<ClinicRoutingDecision> => {
    const cachedModel = createCachedGeminiModel(cache!.apiKey, cache!.modelName, handle);
    return (await options.supervisorLlm
      .bindRoutingTools(schema, { model: cachedModel })
      .invoke(buildCachedMessages(dynamic, history), config)) as ClinicRoutingDecision;
  };

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const staticPrompt = options.loadSupervisorPrompt().trim();
    const dynamic = options.buildSupervisorDynamicContext?.().trim() ?? "";
    const history = stripToolsForSupervisor(state.messages);

    let decision: ClinicRoutingDecision;
    try {
      let handle: ContextCacheHandle | null = null;
      if (cache) {
        handle = await cache.manager.getOrCreate({
          modelName: cache.modelName,
          staticSystemInstruction: staticPrompt,
          tools: [],
          displayName: cache.displayName ?? "clinic-supervisor",
        });
      }

      if (handle) {
        try {
          decision = await invokeCached(handle, dynamic, history, config);
        } catch (error) {
          if (!isCachedContentNotFoundError(error)) {
            throw error;
          }
          cache!.manager.invalidate(handle.cacheName);
          const recreated = await cache!.manager.getOrCreate({
            modelName: cache!.modelName,
            staticSystemInstruction: staticPrompt,
            tools: [],
            displayName: cache!.displayName ?? "clinic-supervisor",
          });
          decision = recreated
            ? await invokeCached(recreated, dynamic, history, config)
            : await invokeUncached(staticPrompt, dynamic, history, config);
        }
      } else {
        decision = await invokeUncached(staticPrompt, dynamic, history, config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[clinic-supervisor] routing failed:", message);
      return routingFailureUpdate(message);
    }

    return resolveRoutingDecision(decision, state, enabledIds);
  };
};

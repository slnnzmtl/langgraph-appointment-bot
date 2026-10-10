import type { BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
  type ContextCacheManager,
} from "@personal-assistant/llm-gemini";

import {
  formatGreetingContact,
  formatPlannedVisitsFlag,
} from "../context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "../gemini-cache-messages.js";
import {
  type ClinicRoutingDecision,
  buildClinicRoutingSchema,
} from "../routing.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  type AgentPrefetchResult,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "../types.js";
import {
  buildSupervisorTurnContext,
  refetchForVisitStatus,
  type SupervisorTurnContext,
  PREFETCH_TTL_MS,
} from "./context.js";
import { formatOpenInteractionContext } from "./open-interaction.js";
import { resolvePreLlmRoute } from "./pre-llm.js";
import { applyModelDecision } from "./post-llm.js";
import { routingFailureUpdate } from "./resolve-routing.js";
import {
  emitSupervisorRoutingDecision,
  type RouteOutcome,
} from "./telemetry.js";

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
  prefetch?: () => Promise<AgentPrefetchResult>;
  prefetchTtlMs?: number;
  contextCache?: SupervisorContextCacheOptions;
};

export { PREFETCH_TTL_MS };

const finalize = (
  ctx: SupervisorTurnContext,
  outcome: RouteOutcome,
  decision?: ClinicRoutingDecision,
): ClinicStateUpdate => {
  emitSupervisorRoutingDecision({
    path: outcome.path,
    ...(decision?.intent != null ? { intent: decision.intent } : {}),
    ...(decision?.choiceId != null ? { choiceId: decision.choiceId } : {}),
    ...(outcome.choiceAccepted != null ? { choiceAccepted: outcome.choiceAccepted } : {}),
    regexStatusSignal: ctx.visitStatusIntent,
    ...(typeof outcome.update.next === "string" ? { next: outcome.update.next } : {}),
    ...(outcome.draftDiscarded != null ? { draftDiscarded: outcome.draftDiscarded } : {}),
  });
  return outcome.update;
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
    let ctx = await buildSupervisorTurnContext(state, {
      ...(options.prefetch != null ? { prefetch: options.prefetch } : {}),
      ...(options.prefetchTtlMs != null ? { prefetchTtlMs: options.prefetchTtlMs } : {}),
    });

    const preLlm = resolvePreLlmRoute(ctx);
    if (preLlm != null) {
      return finalize(ctx, preLlm);
    }

    const dynamic = [
      options.buildSupervisorDynamicContext?.().trim() ?? "",
      formatOpenInteractionContext(state.pendingInteraction),
      formatGreetingContact(ctx.contactContext),
      formatPlannedVisitsFlag(ctx.bookingContext),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

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
          decision = await invokeCached(handle, dynamic, ctx.history, config);
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
            ? await invokeCached(recreated, dynamic, ctx.history, config)
            : await invokeUncached(staticPrompt, dynamic, ctx.history, config);
        }
      } else {
        decision = await invokeUncached(staticPrompt, dynamic, ctx.history, config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finalize(ctx, {
        path: "routing_failure",
        update: {
          ...routingFailureUpdate(message),
          ...ctx.prefetchUpdate,
        },
      });
    }

    if (decision.intent === "visit_status") {
      ctx = await refetchForVisitStatus(ctx, options.prefetch);
    }

    return finalize(ctx, applyModelDecision(ctx, decision, enabledIds), decision);
  };
};

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";

import type { McpCallTool } from "../shared/mcp.js";
import {
  extractContactIdFromSearchResult,
  lookupContactByTelegram,
  lookupPlannedMeetings,
  normalizeContactLookupResult,
} from "../tools/index.js";
import {
  createAgentFinalizeNode,
  createAgentLlmNode,
  createAgentPrepareNode,
  createAgentToolsNode,
  finalizeNodeName,
  llmNodeName,
  prepareNodeName,
  routeAfterAgentLlm,
  routeAfterAgentTools,
  toolsNodeName,
} from "./agent-loop.js";
import type { AgentPrefetchResult } from "./types.js";
import { createClinicStateAnnotation } from "./state.js";
import {
  PREFETCH_TTL_MS,
  createClinicSupervisorNode,
  type SupervisorContextCacheOptions,
} from "./supervisor.js";
import {
  FINISH_ROUTE,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "./types.js";

export { PREFETCH_TTL_MS };

export type CompileClinicGraphOptions = {
  agents: ClinicAgentDefinition[];
  agentTools: Record<string, StructuredToolInterface[]>;
  agentModel: BaseChatModel;
  agentModelName?: string;
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  messageHistoryMaxTokens: number;
  checkpointer?: BaseCheckpointSaver;
  contextCache?: SupervisorContextCacheOptions;
  /** When set, supervisor prefetches Telegram contact and planned meetings. Booking prepare reuses that state. */
  bookingPrefetchCallTool?: McpCallTool;
  /** Override checkpoint prefetch TTL (default PREFETCH_TTL_MS). */
  prefetchTtlMs?: number;
};

export const prefetchBookingContext = async (callTool: McpCallTool): Promise<AgentPrefetchResult> => {
  const contactJson = await lookupContactByTelegram(callTool);
  const contactContext = normalizeContactLookupResult(contactJson);
  const contactId = extractContactIdFromSearchResult(contactJson);
  if (!contactId) {
    return { contactContext, bookingContext: null };
  }
  const listed = await lookupPlannedMeetings(callTool, contactId);
  return { contactContext, bookingContext: listed };
};

export const compileClinicGraph = (options: CompileClinicGraphOptions) => {
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const stateAnnotation = createClinicStateAnnotation({
    messageHistoryMaxTokens: options.messageHistoryMaxTokens,
  });

  const callTool = options.bookingPrefetchCallTool;
  const prefetch = callTool ? () => prefetchBookingContext(callTool) : undefined;

  const supervisorNode = createClinicSupervisorNode({
    agents: options.agents,
    supervisorLlm: options.supervisorLlm,
    loadSupervisorPrompt: options.loadSupervisorPrompt,
    ...(options.buildSupervisorDynamicContext
      ? { buildSupervisorDynamicContext: options.buildSupervisorDynamicContext }
      : {}),
    ...(prefetch ? { prefetch } : {}),
    prefetchTtlMs: options.prefetchTtlMs ?? PREFETCH_TTL_MS,
    ...(options.contextCache ? { contextCache: options.contextCache } : {}),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- StateGraph generics are verbose for dynamic agent nodes
  let graph: any = new StateGraph(stateAnnotation).addNode("supervisor", supervisorNode);

  const supervisorRoutes: Record<string, string> = {
    [FINISH_ROUTE]: END,
  };

  for (const agent of options.agents) {
    const tools = options.agentTools[agent.id] ?? [];
    const prepare = prepareNodeName(agent.id);
    const llm = llmNodeName(agent.id);
    const toolsNode = toolsNodeName(agent.id);
    const finalize = finalizeNodeName(agent.id);

    graph = graph
      .addNode(prepare, createAgentPrepareNode(agent.id))
      .addNode(
        llm,
        createAgentLlmNode({
          agent,
          model: options.agentModel,
          tools,
          formatSystemMetadata: options.formatSystemMetadata,
          ...(options.contextCache && options.agentModelName
            ? {
                contextCache: {
                  manager: options.contextCache.manager,
                  apiKey: options.contextCache.apiKey,
                  modelName: options.agentModelName,
                },
              }
            : {}),
        }),
      )
      .addNode(toolsNode, createAgentToolsNode(tools))
      .addNode(finalize, createAgentFinalizeNode(agent))
      .addEdge(prepare, llm)
      .addConditionalEdges(
        llm,
        (state: { stepCount: number; agentMessages: unknown[] }) =>
          routeAfterAgentLlm(
            state as never,
            agent.maxSteps,
            toolsNode,
            finalize,
          ),
        {
          [toolsNode]: toolsNode,
          [finalize]: finalize,
        },
      )
      .addConditionalEdges(
        toolsNode,
        (state: { agentMessages: unknown[] }) =>
          routeAfterAgentTools(state as never, llm, toolsNode),
        {
          [llm]: llm,
          [toolsNode]: toolsNode,
        },
      )
      .addEdge(finalize, END);

    supervisorRoutes[agent.id] = prepare;
  }

  const compiled = graph
    .addEdge(START, "supervisor")
    .addConditionalEdges(
      "supervisor",
      (state: { next?: string }) => state.next ?? FINISH_ROUTE,
      supervisorRoutes,
    )
    .compile({ checkpointer });

  return { graph: compiled, checkpointer };
};

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
import { lookupContactByTelegram } from "../tools/clinic-tools.js";
import {
  buildPrefetchedContactMessages,
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
import { createClinicStateAnnotation } from "./state.js";
import {
  createClinicSupervisorNode,
  type SupervisorContextCacheOptions,
} from "./supervisor.js";
import {
  BOOKING_AGENT_ID,
  FINISH_ROUTE,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "./types.js";

export type CompileClinicGraphOptions = {
  agents: ClinicAgentDefinition[];
  agentTools: Record<string, StructuredToolInterface[]>;
  agentModel: BaseChatModel;
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  messageHistoryMaxTokens: number;
  checkpointer?: BaseCheckpointSaver;
  contextCache?: SupervisorContextCacheOptions;
  /** When set, booking prepare prefetches find_contact_by_telegram before the first LLM turn. */
  bookingContactLookup?: McpCallTool;
};

export const compileClinicGraph = (options: CompileClinicGraphOptions) => {
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const stateAnnotation = createClinicStateAnnotation({
    messageHistoryMaxTokens: options.messageHistoryMaxTokens,
  });

  const supervisorNode = createClinicSupervisorNode({
    agents: options.agents,
    supervisorLlm: options.supervisorLlm,
    loadSupervisorPrompt: options.loadSupervisorPrompt,
    ...(options.buildSupervisorDynamicContext
      ? { buildSupervisorDynamicContext: options.buildSupervisorDynamicContext }
      : {}),
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

    const bookingLookup = options.bookingContactLookup;
    const prepareNode =
      agent.id === BOOKING_AGENT_ID && bookingLookup
        ? createAgentPrepareNode(agent.id, {
            prefetch: async () =>
              buildPrefetchedContactMessages(await lookupContactByTelegram(bookingLookup)),
          })
        : createAgentPrepareNode(agent.id);

    graph = graph
      .addNode(prepare, prepareNode)
      .addNode(
        llm,
        createAgentLlmNode({
          agent,
          model: options.agentModel,
          tools,
          formatSystemMetadata: options.formatSystemMetadata,
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

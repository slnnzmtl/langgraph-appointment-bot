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
import { lookupLatestHeldMeeting } from "../tools/planned-meetings.js";
import {
  createAgentFinalizeNode,
  createAgentMutationFinalizeNode,
  createAgentCommandPrepareNode,
  createAgentLlmNode,
  createAgentPrepareNode,
  createAgentToolsNode,
  finalizeNodeName,
  llmNodeName,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  prepareNodeName,
  commandPrepareNodeName,
  mutationFinalizeNodeName,
  routeAfterAgentPrepare,
  routeAfterAgentLlm,
  routeAfterAgentTools,
  toolsNodeName,
} from "./agent-loop.js";
import { createNoteTurnClassifier } from "./booking-note-classifier.js";
import {
  createBookingInteractionRenderNode,
  createBookingNoteOrchestratorNode,
  interactionRenderNodeName,
  noteOrchestratorNodeName,
  type ResolveServiceChange,
} from "./booking-note-orchestrator.js";
import type { AgentPrefetchResult } from "./types.js";
import { createClinicStateAnnotation } from "./state.js";
import {
  PREFETCH_TTL_MS,
  createClinicSupervisorNode,
  type SupervisorContextCacheOptions,
} from "./supervisor.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  FINISH_ROUTE,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "./types.js";

export { PREFETCH_TTL_MS };

/** Phase-4 replaces this with CRM catalog resolution. */
const unresolvedServiceChange: ResolveServiceChange = async () => ({
  type: "service_unresolved",
});

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
  /** Injected note-turn classifier (tests). Defaults to Gemini structured output. */
  classifyNoteTurn?: ReturnType<typeof createNoteTurnClassifier>;
  /** Injected service resolver (tests). Defaults to unresolved until phase 4. */
  resolveServiceChange?: ResolveServiceChange;
};

export const prefetchBookingContext = async (callTool: McpCallTool): Promise<AgentPrefetchResult> => {
  const contactJson = await lookupContactByTelegram(callTool);
  const normalizedContactContext = normalizeContactLookupResult(contactJson);
  const contactId = extractContactIdFromSearchResult(contactJson);
  const contactContext = contactId
    ? { ...normalizedContactContext, ownership: "telegram" as const }
    : normalizedContactContext;
  if (!contactId) {
    return { contactContext, bookingContext: null };
  }
  const listed = await lookupPlannedMeetings(callTool, contactId);
  if (!listed) {
    return { contactContext, bookingContext: null };
  }
  const latestHeld = await lookupLatestHeldMeeting(callTool, contactId);
  return { contactContext, bookingContext: { ...listed, latestHeld } };
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
    const commandPrepare = commandPrepareNodeName(agent.id);
    const llm = llmNodeName(agent.id);
    const toolsNode = toolsNodeName(agent.id);
    const finalize = finalizeNodeName(agent.id);
    const mutationFinalize = mutationFinalizeNodeName(agent.id);
    const noteOrch = noteOrchestratorNodeName(agent.id);
    const interactionRender = interactionRenderNodeName(agent.id);
    const isBooking = agent.id === BOOKING_AGENT_ID;

    graph = graph
      .addNode(prepare, createAgentPrepareNode(agent.id))
      .addNode(commandPrepare, createAgentCommandPrepareNode(agent.id))
      .addNode(mutationFinalize, createAgentMutationFinalizeNode(agent))
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
      .addNode(toolsNode, createAgentToolsNode(tools, agent.id))
      .addNode(finalize, createAgentFinalizeNode(agent));

    if (isBooking) {
      const classify = options.classifyNoteTurn
        ?? createNoteTurnClassifier(options.supervisorLlm);
      const resolve = options.resolveServiceChange ?? unresolvedServiceChange;
      const faqPrepare = options.agents.some((entry) => entry.id === FAQ_AGENT_ID)
        ? prepareNodeName(FAQ_AGENT_ID)
        : null;
      const orchEnds = [
        llm,
        commandPrepare,
        interactionRender,
        ...(faqPrepare != null ? [faqPrepare] : []),
      ];
      graph = graph
        .addNode(
          noteOrch,
          createBookingNoteOrchestratorNode({
            classify,
            resolveServiceChange: resolve,
            matchScheduleFromState: (text, state) => {
              const days = state.availabilityContext?.days ?? [];
              const day = matchAvailabilityDay(text, days);
              if (day) {
                return { type: "date_selected", date: day.date };
              }
              const slot = matchAvailabilitySlot(
                text,
                state.availabilityContext,
                state.bookingDraft?.selectedDate,
              );
              return slot != null ? { type: "slot_selected", slot } : null;
            },
            nodes: {
              bookingLlm: llm,
              commandPrepare,
              interactionRender,
              // When FAQ is not compiled into this graph (unit tests), re-ask in booking.
              faqPrepare: faqPrepare ?? interactionRender,
            },
          }),
          {
            ends: orchEnds,
          },
        )
        .addNode(interactionRender, createBookingInteractionRenderNode(agent))
        .addEdge(interactionRender, finalize);
    }

    graph = graph
      .addConditionalEdges(
        prepare,
        (state: { agentMessages: unknown[] }) =>
          routeAfterAgentPrepare(
            state as never,
            llm,
            isBooking ? commandPrepare : undefined,
            isBooking ? noteOrch : undefined,
          ),
        {
          [llm]: llm,
          [commandPrepare]: commandPrepare,
          ...(isBooking ? { [noteOrch]: noteOrch } : {}),
        },
      )
      .addConditionalEdges(
        llm,
        (state: { stepCount: number; agentMessages: unknown[] }) =>
          routeAfterAgentLlm(
            state as never,
            agent.maxSteps,
            toolsNode,
            finalize,
            isBooking ? commandPrepare : undefined,
          ),
        {
          [toolsNode]: toolsNode,
          [commandPrepare]: commandPrepare,
          [finalize]: finalize,
        },
      )
      .addEdge(commandPrepare, toolsNode)
      .addConditionalEdges(
        toolsNode,
        (state: { agentMessages: unknown[] }) =>
          routeAfterAgentTools(
            state as never,
            llm,
            toolsNode,
            isBooking ? mutationFinalize : undefined,
            isBooking ? commandPrepare : undefined,
          ),
        {
          [llm]: llm,
          [toolsNode]: toolsNode,
          [mutationFinalize]: mutationFinalize,
          [commandPrepare]: commandPrepare,
        },
      )
      .addEdge(finalize, END);

    graph = graph.addEdge(mutationFinalize, END);

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

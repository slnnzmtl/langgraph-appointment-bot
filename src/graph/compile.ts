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
import { kyivToday } from "../tools/availability-slots.js";
import { lookupLatestHeldMeeting } from "../tools/planned-meetings.js";
import { normalizeListServicesResult } from "../tools/service-tools.js";
import { resolveBookingScheduleRequest } from "./booking-schedule.js";
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
} from "./agent-loop/index.js";
import { createNoteTurnClassifier } from "./booking-note-classifier.js";
import { createContactNameClassifier } from "./contact-name-classifier.js";
import {
  createBookingInteractionRenderNode,
  createBookingNoteOrchestratorNode,
  interactionRenderNodeName,
  noteOrchestratorNodeName,
  type ResolveServiceChange,
} from "./booking-note-orchestrator.js";
import {
  createResolveServiceChange,
  createServiceCandidatePartitioner,
  createServiceCandidateSelector,
} from "./service-resolution.js";
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

/** Fallback when no MCP callTool is wired (unit graphs without CRM). */
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
  /** Injected contact-name classifier (tests). Defaults to Gemini structured output. */
  classifyContactName?: ReturnType<typeof createContactNameClassifier>;
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

  const faqListServicesTool = options.agentTools[FAQ_AGENT_ID]
    ?.find((entry) => entry.name === "list_services");
  const loadServices = faqListServicesTool != null
    ? async () => normalizeListServicesResult(String(await faqListServicesTool.invoke({})))
    : undefined;

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
    ...(loadServices != null ? { loadServices } : {}),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- StateGraph generics are verbose for dynamic agent nodes
  let graph: any = new StateGraph(stateAnnotation).addNode("supervisor", supervisorNode);

  const supervisorRoutes: Record<string, string> = {
    [FINISH_ROUTE]: END,
  };

  const faqPartitionCandidates = options.agents.some((entry) => entry.id === FAQ_AGENT_ID)
    ? createServiceCandidatePartitioner(options.supervisorLlm)
    : undefined;
  const faqSelectCandidates = options.agents.some((entry) => entry.id === FAQ_AGENT_ID)
    ? createServiceCandidateSelector(options.supervisorLlm)
    : undefined;

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

    const classifyContactName = isBooking
      ? (options.classifyContactName ?? createContactNameClassifier(options.supervisorLlm))
      : undefined;

    const prepareOptions = agent.id === FAQ_AGENT_ID || isBooking
      ? {
          ...(faqPartitionCandidates != null
            ? { partitionCandidates: faqPartitionCandidates }
            : {}),
          ...(faqSelectCandidates != null
            ? { selectCandidates: faqSelectCandidates }
            : {}),
          ...(loadServices != null ? { loadServices } : {}),
          ...(isBooking && classifyContactName != null
            ? { classifyContactName }
            : {}),
        }
      : undefined;

    graph = graph
      .addNode(
        prepare,
        createAgentPrepareNode(
          agent.id,
          prepareOptions,
        ),
      )
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
      .addNode(
        toolsNode,
        createAgentToolsNode(
          tools,
          agent.id,
          isBooking && faqPartitionCandidates != null
            ? { partitionCandidates: faqPartitionCandidates }
            : undefined,
        ),
      )
      .addNode(
        finalize,
        createAgentFinalizeNode(
          agent,
          agent.id === FAQ_AGENT_ID
            ? {
                ...(faqPartitionCandidates != null
                  ? { partitionCandidates: faqPartitionCandidates }
                  : {}),
                ...(faqSelectCandidates != null
                  ? { selectCandidates: faqSelectCandidates }
                  : {}),
                ...(loadServices != null ? { loadServices } : {}),
              }
            : undefined,
        ),
        // Safety-net path may return the same abandon Command as mutationFinalize.
        { ends: [END, "supervisor"] },
      );

    if (isBooking) {
      const classify = options.classifyNoteTurn
        ?? createNoteTurnClassifier(options.supervisorLlm);
      const resolve = options.resolveServiceChange
        ?? (callTool != null
          ? createResolveServiceChange(callTool, options.supervisorLlm)
          : unresolvedServiceChange);
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
        .addNode(commandPrepare, createAgentCommandPrepareNode(agent.id))
        .addNode(
          mutationFinalize,
          createAgentMutationFinalizeNode(agent),
          // Plain updates follow the static edge to END; main-menu leave Command
          // hands control back to the supervisor's existing greeting path.
          { ends: [END, "supervisor"] },
        )
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
              if (slot != null) {
                // Same-slot reaffirm while visit_note is open → trusted no-op
                // (skip classifier; keep skip chip via unresolved → interaction_render).
                if (
                  state.pendingInteraction?.kind === "visit_note"
                  && state.bookingDraft?.selectedSlot?.dateStart === slot.dateStart
                ) {
                  return { type: "same_slot_ignored" };
                }
                return { type: "slot_selected", slot };
              }
              // Lexical exact date («завтра», «20 жовтня») while DATE/TIME/note open.
              const schedule = resolveBookingScheduleRequest(text, kyivToday(), {
                availabilityContext: state.availabilityContext,
                availabilityCursor: state.availabilityCursor,
                selectedDate: state.bookingDraft?.selectedDate,
              });
              if (schedule?.kind === "exact" && schedule.date != null) {
                return { type: "date_selected", date: schedule.date };
              }
              return null;
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
        .addEdge(interactionRender, finalize)
        .addEdge(commandPrepare, toolsNode)
        .addEdge(mutationFinalize, END);
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
            finalize,
            agent.id,
          ),
        {
          [llm]: llm,
          [finalize]: finalize,
          ...(isBooking
            ? { [commandPrepare]: commandPrepare, [noteOrch]: noteOrch }
            : {}),
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
          [finalize]: finalize,
          ...(isBooking ? { [commandPrepare]: commandPrepare } : {}),
        },
      )
      .addConditionalEdges(
        toolsNode,
        (state: { agentMessages: unknown[] }) =>
          routeAfterAgentTools(
            state as never,
            llm,
            toolsNode,
            isBooking ? mutationFinalize : undefined,
            isBooking ? commandPrepare : undefined,
            isBooking ? noteOrch : undefined,
            isBooking ? finalize : undefined,
          ),
        {
          [llm]: llm,
          [toolsNode]: toolsNode,
          ...(isBooking
            ? {
                [mutationFinalize]: mutationFinalize,
                [commandPrepare]: commandPrepare,
                [noteOrch]: noteOrch,
                [finalize]: finalize,
              }
            : {}),
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

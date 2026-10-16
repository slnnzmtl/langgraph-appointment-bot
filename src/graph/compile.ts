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
  filterBookingInformationalTools,
  lookupContactByTelegram,
  lookupPlannedMeetings,
  normalizeContactLookupResult,
} from "../tools/index.js";
import { kyivToday } from "../tools/availability-slots.js";
import { lookupLatestHeldMeeting } from "../tools/planned-meetings.js";
import { normalizeListServicesResult } from "../tools/service-tools.js";
import { resolveBookingScheduleRequest } from "./booking-schedule.js";
import {
  createBookingFinalizeNode,
  createFaqFinalizeNode,
  createAgentMutationFinalizeNode,
  createAgentCommandPrepareNode,
  createAgentLlmNode,
  createBookingPrepareNode,
  createFaqPrepareNode,
  createAgentToolsNode,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  routeAfterAgentPrepare,
  routeAfterAgentLlm,
  routeAfterAgentTools,
} from "./agent-loop/index.js";
import { createNoteTurnClassifier } from "./booking-note-classifier.js";
import { createContactNameClassifier } from "./contact-name-classifier.js";
import {
  createBookingInteractionRenderNode,
  createBookingNoteOrchestratorNode,
  type ResolveServiceChange,
} from "./booking-note-orchestrator.js";
import {
  createResolveServiceChange,
  createServiceCandidatePartitioner,
  createServiceCandidateSelector,
} from "./service-resolution.js";
import type { AgentPrefetchResult } from "./types.js";
import { createClinicStateAnnotation, type ClinicState } from "./state.js";
import {
  PREFETCH_TTL_MS,
  createClinicSupervisorNode,
  type SupervisorContextCacheOptions,
} from "./supervisor.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  FINISH_ROUTE,
  type ClinicAgentId,
  type ClinicRouteId,
  type ClinicSpecialists,
  type ILLMConnector,
} from "./types.js";

export { PREFETCH_TTL_MS };

const FAQ_PREPARE = "faq__prepare" as const;
const FAQ_LLM = "faq__llm" as const;
const FAQ_TOOLS = "faq__tools" as const;
const FAQ_FINALIZE = "faq__finalize" as const;

const BOOKING_PREPARE = "booking__prepare" as const;
const BOOKING_COMMAND_PREPARE = "booking__command_prepare" as const;
const BOOKING_LLM = "booking__llm" as const;
const BOOKING_TOOLS = "booking__tools" as const;
const BOOKING_FINALIZE = "booking__finalize" as const;
const BOOKING_MUTATION_FINALIZE = "booking__mutation_finalize" as const;
const BOOKING_NOTE_ORCH = "booking__note_orchestrator" as const;
const BOOKING_INTERACTION_RENDER = "booking__interaction_render" as const;

/** Fallback when no MCP callTool is wired (unit graphs without CRM). */
const unresolvedServiceChange: ResolveServiceChange = async () => ({
  type: "service_unresolved",
});

export type CompileClinicGraphOptions = {
  specialists: ClinicSpecialists;
  agentTools: Record<ClinicAgentId, StructuredToolInterface[]>;
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

const assertClinicSpecialists = (specialists: ClinicSpecialists): void => {
  if (
    specialists.faq.id !== FAQ_AGENT_ID
    || specialists.booking.id !== BOOKING_AGENT_ID
  ) {
    throw new Error(
      "compileClinicGraph requires FAQ and booking specialists with matching ids",
    );
  }
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
  assertClinicSpecialists(options.specialists);
  const faqAgent = options.specialists.faq;
  const bookingAgent = options.specialists.booking;
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

  const faqPartitionCandidates = createServiceCandidatePartitioner(options.supervisorLlm);
  const faqSelectCandidates = createServiceCandidateSelector(options.supervisorLlm);
  const faqCatalogOptions = {
    partitionCandidates: faqPartitionCandidates,
    selectCandidates: faqSelectCandidates,
    ...(loadServices != null ? { loadServices } : {}),
  };

  const supervisorNode = createClinicSupervisorNode({
    specialists: options.specialists,
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

  const faqPrepare = FAQ_PREPARE;
  const faqLlm = FAQ_LLM;
  const faqTools = FAQ_TOOLS;
  const faqFinalize = FAQ_FINALIZE;

  const bookingPrepare = BOOKING_PREPARE;
  const bookingCommandPrepare = BOOKING_COMMAND_PREPARE;
  const bookingLlm = BOOKING_LLM;
  const bookingTools = BOOKING_TOOLS;
  const bookingFinalize = BOOKING_FINALIZE;
  const bookingMutationFinalize = BOOKING_MUTATION_FINALIZE;
  const bookingNoteOrch = BOOKING_NOTE_ORCH;
  const bookingInteractionRender = BOOKING_INTERACTION_RENDER;

  const faqToolList = options.agentTools[FAQ_AGENT_ID] ?? [];
  const bookingToolList = options.agentTools[BOOKING_AGENT_ID] ?? [];
  const bookingLlmTools = filterBookingInformationalTools(bookingToolList);

  const classifyContactName = options.classifyContactName
    ?? createContactNameClassifier(options.supervisorLlm);

  const llmContextCache = options.contextCache && options.agentModelName
    ? {
        contextCache: {
          manager: options.contextCache.manager,
          apiKey: options.contextCache.apiKey,
          modelName: options.agentModelName,
        },
      }
    : {};

  const classify = options.classifyNoteTurn
    ?? createNoteTurnClassifier(options.supervisorLlm);
  const resolve = options.resolveServiceChange
    ?? (callTool != null
      ? createResolveServiceChange(callTool, options.supervisorLlm)
      : unresolvedServiceChange);

  const supervisorRoutes: Record<
    ClinicRouteId,
    typeof END | typeof FAQ_PREPARE | typeof BOOKING_PREPARE
  > = {
    [FINISH_ROUTE]: END,
    [FAQ_AGENT_ID]: faqPrepare,
    [BOOKING_AGENT_ID]: bookingPrepare,
  };

  const compiled = new StateGraph(stateAnnotation)
    .addNode("supervisor", supervisorNode)
    .addNode(faqPrepare, createFaqPrepareNode(faqCatalogOptions))
    .addNode(
      faqLlm,
      createAgentLlmNode({
        agent: faqAgent,
        model: options.agentModel,
        tools: faqToolList,
        formatSystemMetadata: options.formatSystemMetadata,
        ...llmContextCache,
      }),
    )
    .addNode(faqTools, createAgentToolsNode(faqToolList, FAQ_AGENT_ID))
    .addNode(
      faqFinalize,
      createFaqFinalizeNode(faqAgent, faqCatalogOptions),
      { ends: [END, "supervisor"] },
    )
    .addConditionalEdges(
      faqPrepare,
      (state: ClinicState) =>
        routeAfterAgentPrepare(
          state,
          faqLlm,
          undefined,
          undefined,
          faqFinalize,
          FAQ_AGENT_ID,
        ),
      {
        [faqLlm]: faqLlm,
        [faqFinalize]: faqFinalize,
      },
    )
    .addConditionalEdges(
      faqLlm,
      (state: ClinicState) =>
        routeAfterAgentLlm(
          state,
          faqAgent.maxSteps,
          faqTools,
          faqFinalize,
        ),
      {
        [faqTools]: faqTools,
        [faqFinalize]: faqFinalize,
      },
    )
    .addConditionalEdges(
      faqTools,
      (state: ClinicState) =>
        routeAfterAgentTools(state, faqLlm, faqTools),
      {
        [faqLlm]: faqLlm,
        [faqTools]: faqTools,
      },
    )
    .addEdge(faqFinalize, END)
    .addNode(
      bookingPrepare,
      createBookingPrepareNode({ classifyContactName }),
    )
    .addNode(
      bookingLlm,
      createAgentLlmNode({
        agent: bookingAgent,
        model: options.agentModel,
        tools: bookingLlmTools,
        formatSystemMetadata: options.formatSystemMetadata,
        ...llmContextCache,
      }),
    )
    .addNode(bookingTools, createAgentToolsNode(bookingToolList, BOOKING_AGENT_ID))
    .addNode(
      bookingFinalize,
      createBookingFinalizeNode(bookingAgent),
      { ends: [END, "supervisor"] },
    )
    .addNode(
      bookingCommandPrepare,
      createAgentCommandPrepareNode({
        tools: bookingTools,
        interactionRender: bookingInteractionRender,
        llm: bookingLlm,
        finalize: bookingFinalize,
      }),
      { ends: [bookingTools, bookingInteractionRender, bookingLlm, bookingFinalize] },
    )
    .addNode(
      bookingMutationFinalize,
      createAgentMutationFinalizeNode(bookingAgent),
      { ends: [END, "supervisor"] },
    )
    .addNode(
      bookingNoteOrch,
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
            if (
              state.pendingInteraction?.kind === "visit_note"
              && state.bookingDraft?.selectedSlot?.dateStart === slot.dateStart
            ) {
              return { type: "same_slot_ignored" };
            }
            return { type: "slot_selected", slot };
          }
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
          bookingLlm,
          commandPrepare: bookingCommandPrepare,
          interactionRender: bookingInteractionRender,
          faqPrepare,
        },
      }),
      {
        ends: [bookingLlm, bookingCommandPrepare, bookingInteractionRender, faqPrepare],
      },
    )
    .addNode(
      bookingInteractionRender,
      createBookingInteractionRenderNode(bookingAgent),
    )
    .addEdge(bookingInteractionRender, bookingFinalize)
    .addEdge(bookingMutationFinalize, END)
    .addConditionalEdges(
      bookingPrepare,
      (state: ClinicState) =>
        routeAfterAgentPrepare(
          state,
          bookingLlm,
          bookingCommandPrepare,
          bookingNoteOrch,
          bookingFinalize,
          BOOKING_AGENT_ID,
        ),
      {
        [bookingLlm]: bookingLlm,
        [bookingFinalize]: bookingFinalize,
        [bookingCommandPrepare]: bookingCommandPrepare,
        [bookingNoteOrch]: bookingNoteOrch,
      },
    )
    .addConditionalEdges(
      bookingLlm,
      (state: ClinicState) =>
        routeAfterAgentLlm(
          state,
          bookingAgent.maxSteps,
          bookingTools,
          bookingFinalize,
          bookingCommandPrepare,
        ),
      {
        [bookingTools]: bookingTools,
        [bookingFinalize]: bookingFinalize,
        [bookingCommandPrepare]: bookingCommandPrepare,
      },
    )
    .addConditionalEdges(
      bookingTools,
      (state: ClinicState) =>
        routeAfterAgentTools(
          state,
          bookingLlm,
          bookingTools,
          bookingMutationFinalize,
          bookingCommandPrepare,
          bookingNoteOrch,
          bookingFinalize,
          faqPrepare,
        ),
      {
        [bookingLlm]: bookingLlm,
        [bookingTools]: bookingTools,
        [bookingMutationFinalize]: bookingMutationFinalize,
        [bookingCommandPrepare]: bookingCommandPrepare,
        [bookingNoteOrch]: bookingNoteOrch,
        [bookingFinalize]: bookingFinalize,
        [faqPrepare]: faqPrepare,
      },
    )
    .addEdge(bookingFinalize, END)
    .addEdge(START, "supervisor")
    .addConditionalEdges(
      "supervisor",
      (state: ClinicState) => state.next ?? FINISH_ROUTE,
      supervisorRoutes,
    )
    .compile({ checkpointer });

  return { graph: compiled, checkpointer };
};

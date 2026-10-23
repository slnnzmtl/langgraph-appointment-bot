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
import { normalizeListServicesResult } from "../tools/service-tools.js";
import {
  assertBoundAgentToolNames,
  assertBookingRuntimeToolNames,
} from "./bound-tools.js";
import {
  createFaqFinalizeNode,
  createAgentLlmNode,
  createFaqPrepareNode,
  createAgentToolsNode,
  routeAfterAgentPrepare,
  routeAfterAgentLlm,
  routeAfterAgentTools,
  routeAfterBookingTools,
} from "./agent-loop/index.js";
import {
  BOOKING_DECIDE_NODE,
  BOOKING_EFFECTS_NODE,
  createBookingDecideNode,
} from "./agent-loop/booking-decide-nodes.js";
import {
  BOOKING_RESPOND_NODE,
  createBookingRespondNode,
} from "./agent-loop/booking-respond.js";
import { createBookingTurnInterpreter } from "./agent-loop/booking-turn-interpreter.js";
import {
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
import { hasPendingToolCalls } from "./tool-routing.js";

export { PREFETCH_TTL_MS };

const FAQ_PREPARE = "faq__prepare" as const;
const FAQ_LLM = "faq__llm" as const;
const FAQ_TOOLS = "faq__tools" as const;
const FAQ_FINALIZE = "faq__finalize" as const;

const BOOKING_DECIDE = BOOKING_DECIDE_NODE;
const BOOKING_TOOLS = BOOKING_EFFECTS_NODE;
const BOOKING_RESPOND = BOOKING_RESPOND_NODE;

export type CompileClinicGraphOptions = {
  specialists: ClinicSpecialists;
  agentTools: Record<ClinicAgentId, StructuredToolInterface[]>;
  agentModel: BaseChatModel;
  agentModelName?: string;
  supervisorLlm: ILLMConnector;
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  messageHistoryMaxTokens: number;
  checkpointer?: BaseCheckpointSaver;
  /** Optional Gemini context cache for the FAQ LLM only (not supervisor). */
  contextCache?: SupervisorContextCacheOptions;
  /** When set, supervisor prefetches Telegram contact and planned meetings. */
  bookingPrefetchCallTool?: McpCallTool;
  /** Override checkpoint prefetch TTL (default PREFETCH_TTL_MS). */
  prefetchTtlMs?: number;
  /** Injected booking turn interpreter (tests). */
  interpretBookingTurn?: ReturnType<typeof createBookingTurnInterpreter>;
  /** Espo assigned user for create_meeting HITL CRM command freeze. */
  assignedUserId?: string;
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

  const faqPrepare = FAQ_PREPARE;
  const faqLlm = FAQ_LLM;
  const faqTools = FAQ_TOOLS;
  const faqFinalize = FAQ_FINALIZE;

  const bookingDecide = BOOKING_DECIDE;
  const bookingTools = BOOKING_TOOLS;
  const bookingRespond = BOOKING_RESPOND;

  const faqToolList = options.agentTools[FAQ_AGENT_ID] ?? [];
  const bookingToolList = options.agentTools[BOOKING_AGENT_ID] ?? [];
  // FAQ still has an LLM bind; booking ToolNode is runtime-only (no booking LLM).
  assertBoundAgentToolNames(FAQ_AGENT_ID, faqToolList);
  assertBookingRuntimeToolNames(bookingToolList);

  const llmContextCache = options.contextCache && options.agentModelName
    ? {
        contextCache: {
          manager: options.contextCache.manager,
          apiKey: options.contextCache.apiKey,
          modelName: options.agentModelName,
        },
      }
    : {};

  const interpretBookingTurn = options.interpretBookingTurn
    ?? createBookingTurnInterpreter(options.supervisorLlm);

  const supervisorNodeWithIngress = createClinicSupervisorNode({
    ...(prefetch ? { prefetch } : {}),
    prefetchTtlMs: options.prefetchTtlMs ?? PREFETCH_TTL_MS,
    interpretTurn: interpretBookingTurn,
    ...(loadServices != null ? { loadServices } : {}),
  });

  const supervisorRoutes: Record<
    ClinicRouteId,
    typeof END | typeof FAQ_PREPARE | typeof BOOKING_DECIDE
  > = {
    [FINISH_ROUTE]: END,
    [FAQ_AGENT_ID]: faqPrepare,
    [BOOKING_AGENT_ID]: bookingDecide,
  };

  const compiled = new StateGraph(stateAnnotation)
    .addNode("supervisor", supervisorNodeWithIngress)
    .addNode(
      faqPrepare,
      createFaqPrepareNode(faqCatalogOptions),
    )
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
        // Idle unique chips no longer hand off here; explicit book promotes in supervisor.
        routeAfterAgentPrepare(
          state,
          faqLlm,
          faqFinalize,
          undefined,
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
        routeAfterAgentTools(state, {
          llmName: faqLlm,
          toolsName: faqTools,
        }),
      {
        [faqLlm]: faqLlm,
        [faqTools]: faqTools,
      },
    )
    .addEdge(faqFinalize, END)
    .addNode(
      bookingDecide,
      createBookingDecideNode({
        interpretTurn: interpretBookingTurn,
        selectCandidates: faqSelectCandidates,
        partitionCandidates: faqPartitionCandidates,
        ...(options.assignedUserId != null
          ? { assignedUserId: options.assignedUserId }
          : {}),
      }),
    )
    .addNode(bookingTools, createAgentToolsNode(bookingToolList, BOOKING_AGENT_ID))
    .addNode(
      bookingRespond,
      createBookingRespondNode({
        llm: options.supervisorLlm,
        agentName: bookingAgent.name,
      }),
    )
    .addConditionalEdges(
      bookingDecide,
      (state: ClinicState) => {
        if (hasPendingToolCalls(state.agentMessages)) {
          return bookingTools;
        }
        return bookingRespond;
      },
      {
        [bookingTools]: bookingTools,
        [bookingRespond]: bookingRespond,
      },
    )
    .addConditionalEdges(
      bookingTools,
      (state: ClinicState) =>
        routeAfterBookingTools(state, {
          decideName: bookingDecide,
          toolsName: bookingTools,
          respondName: bookingRespond,
        }),
      {
        [bookingDecide]: bookingDecide,
        [bookingTools]: bookingTools,
        [bookingRespond]: bookingRespond,
      },
    )
    .addEdge(bookingRespond, END)
    .addEdge(START, "supervisor")
    .addConditionalEdges(
      "supervisor",
      (state: ClinicState) => state.next ?? FINISH_ROUTE,
      supervisorRoutes,
    )
    .compile({ checkpointer });

  return { graph: compiled, checkpointer };
};

import {
  AIMessage,
  HumanMessage,
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
  PATIENT_FALLBACK_MESSAGE,
  SUPERVISOR_OWNED_REPLY_LABELS,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import {
  extractMessageTextContent,
  extractReplyButtons,
  replyButtonLabels,
} from "../shared/message-content.js";
import {
  formatGreetingContact,
  formatSupervisorVisitLabels,
} from "./context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import {
  normalizeSupervisorReply,
  type ClinicRoutingDecision,
  buildClinicRoutingSchema,
} from "./routing.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import { stripToolNoiseFromMessages } from "./supervisor-history.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  FINISH_ROUTE,
  type AgentPrefetchResult,
  type ClinicAgentDefinition,
  type ILLMConnector,
} from "./types.js";

export type SupervisorContextCacheOptions = {
  manager: ContextCacheManager;
  apiKey: string;
  modelName: string;
  displayName?: string;
};

export const PREFETCH_TTL_MS = 5 * 60 * 1000;

/** Move/cancel after «Мій запис», or cancel-and-rebook after Already booked — sticky to booking. */
const VISIT_CHANGE_ROUTE_LABELS = new Set<string>([
  VISIT_CHANGE_MENU[0],
  VISIT_CHANGE_MENU[1],
  VISIT_CHANGE_MENU_EN[0],
  VISIT_CHANGE_MENU_EN[1],
  BOOKING_REPLACE_MENU[0],
  BOOKING_REPLACE_MENU_EN[0],
]);

export type CreateClinicSupervisorNodeOptions = {
  agents: ClinicAgentDefinition[];
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
  /** Prefetch Telegram contact + planned meetings for greeting and booking state. */
  prefetch?: () => Promise<AgentPrefetchResult>;
  /** Wall-clock freshness for checkpointed prefetch (default 5 minutes). */
  prefetchTtlMs?: number;
  contextCache?: SupervisorContextCacheOptions;
};

export const isPrefetchExpired = (
  fetchedAt: number | null | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean => fetchedAt == null || now - fetchedAt >= ttlMs;

const lastHumanLineFromMessages = (messages: BaseMessage[]): string => {
  const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return "";
  }
  const text = extractMessageTextContent(lastHuman.content).trim();
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1) ?? ""
  );
};

/**
 * Skip the supervisor LLM when the patient taps a shortcut the specialist just
 * offered. Supervisor-owned labels, free text, and yielded handoffs still go
 * through the LLM.
 */
export const shouldContinueInSpecialist = (
  state: ClinicState,
  agentId: string,
): boolean => {
  if (state.lastHandoff?.agentId !== agentId || state.lastHandoff.status !== "ok") {
    return false;
  }
  if (state.lastHandoff.yieldToSupervisor) {
    return false;
  }

  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return false;
  }
  const humanText = extractMessageTextContent(lastHuman.content).trim();
  if (!humanText || SUPERVISOR_OWNED_REPLY_LABELS.has(humanText)) {
    return false;
  }

  const lastAi = [...state.messages].reverse().find((m) => m instanceof AIMessage);
  const labels = replyButtonLabels(
    state.lastHandoff.replyButtons,
    lastAi ? extractMessageTextContent(lastAi.content) : undefined,
  );
  return labels.includes(humanText);
};

export const shouldContinueInBooking = (state: ClinicState): boolean =>
  shouldContinueInSpecialist(state, BOOKING_AGENT_ID);

export const shouldContinueInFaq = (state: ClinicState): boolean =>
  shouldContinueInSpecialist(state, FAQ_AGENT_ID);

/** True when the latest human line is Перенести / Скасувати / cancel-and-rebook (or EN). */
export const isVisitChangeRouteLabel = (state: ClinicState): boolean =>
  VISIT_CHANGE_ROUTE_LABELS.has(lastHumanLineFromMessages(state.messages));

/** Agent id to sticky-continue into, or null when the supervisor LLM must run. */
export const stickyContinueAgentId = (
  state: ClinicState,
): typeof FAQ_AGENT_ID | typeof BOOKING_AGENT_ID | null => {
  // Belt-and-suspenders: Перенести / Скасувати / cancel-and-rebook still route to
  // booking when lastHandoff is missing (FINISH or replace menus store those buttons).
  if (isVisitChangeRouteLabel(state)) {
    return BOOKING_AGENT_ID;
  }
  const agentId = state.lastHandoff?.agentId;
  if (agentId === FAQ_AGENT_ID || agentId === BOOKING_AGENT_ID) {
    return shouldContinueInSpecialist(state, agentId) ? agentId : null;
  }
  return null;
};

const routingFailureUpdate = (reason: string): ClinicStateUpdate => {
  console.error("[clinic-supervisor] routing failure:", reason);
  return {
    next: FINISH_ROUTE,
    lastHandoff: {
      agentId: FINISH_ROUTE,
      agentName: "supervisor",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: [...defaultMenuLabels(false)],
    },
  };
};

const resolveRoutingDecision = (
  decision: ClinicRoutingDecision,
  state: ClinicState,
  enabledIds: Set<string>,
  bookingContext: ClinicState["bookingContext"],
): ClinicStateUpdate => {
  if (decision.next === FINISH_ROUTE) {
    const reply = normalizeSupervisorReply(decision.reply);
    if (!reply) {
      const last = state.messages[state.messages.length - 1];
      if (last instanceof AIMessage && state.lastHandoff) {
        return {
          next: FINISH_ROUTE,
          lastHandoff: null,
        };
      }
      return routingFailureUpdate("FINISH without reply");
    }

    // Strip any stray model trailer; code owns FINISH keyboards from menu + bookingContext.
    const { text } = extractReplyButtons(reply);
    const hasVisit = (bookingContext?.meetings.length ?? 0) > 0;
    const replyButtons =
      decision.menu === "visit_change" && hasVisit
        ? [...VISIT_CHANGE_MENU]
        : [...defaultMenuLabels(hasVisit)];

    return {
      next: FINISH_ROUTE,
      lastHandoff: {
        agentId: FINISH_ROUTE,
        agentName: "supervisor",
        status: "ok",
        replyText: text,
        replyButtons,
      },
      messages: [new AIMessage(text)],
    };
  }

  if (!enabledIds.has(decision.next)) {
    return routingFailureUpdate(`Unknown route: ${decision.next}`);
  }

  return {
    next: decision.next,
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
    const history = stripToolNoiseFromMessages(state.messages);
    const ttlMs = options.prefetchTtlMs ?? PREFETCH_TTL_MS;

    let contactContext = state.contactContext;
    let bookingContext = state.bookingContext;
    let prefetchUpdate: ClinicStateUpdate = {};
    // Match the last HumanMessage in state (not stripped history — consecutive humans are merged there).
    const lastHumanLine = lastHumanLineFromMessages(state.messages);
    // «Мій запис» must always refetch — reminder HITL does not set prefetchDirty.
    const forcePrefetch = /^(мій запис|my visit)$/i.test(lastHumanLine);
    const reusePrefetch =
      state.contactContext != null
      && !state.prefetchDirty
      && !forcePrefetch
      && !isPrefetchExpired(state.prefetchFetchedAt, ttlMs);
    if (options.prefetch && !reusePrefetch) {
      try {
        const prefetched = await options.prefetch();
        contactContext = prefetched.contactContext;
        bookingContext = prefetched.bookingContext;
        prefetchUpdate = {
          ...prefetched,
          prefetchDirty: false,
          prefetchFetchedAt: Date.now(),
          availabilityContext: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[clinic-supervisor] prefetch failed:", message);
      }
    }

    const stickyNext = stickyContinueAgentId(state);
    if (stickyNext) {
      return {
        next: stickyNext,
        lastHandoff: null,
        ...prefetchUpdate,
      };
    }

    const dynamic = [
      options.buildSupervisorDynamicContext?.().trim() ?? "",
      formatGreetingContact(contactContext),
      formatSupervisorVisitLabels(bookingContext),
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
      return { ...routingFailureUpdate(message), ...prefetchUpdate };
    }

    return {
      ...resolveRoutingDecision(decision, state, enabledIds, bookingContext),
      ...prefetchUpdate,
    };
  };
};

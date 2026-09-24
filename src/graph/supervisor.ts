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

import { trackEvent } from "../analytics/track.js";
import {
  PATIENT_FALLBACK_MESSAGE,
  SUPERVISOR_OWNED_REPLY_LABELS,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import {
  extractMessageTextContent,
  extractReplyButtons,
  isBookingOfferQuestion,
  isYesReply,
  mentionsCatalogProcedure,
  replyButtonLabels,
  requestsConsultation,
} from "../shared/message-content.js";
import { normalizeClinicPhone } from "../shared/phone.js";
import { resolveAvailabilityRequest } from "../tools/availability-request.js";
import { kyivToday } from "../tools/availability-slots.js";
import { availabilityCursorFromContext } from "../tools/availability-tools.js";
import {
  attachPrefetchVisits,
  formatGreetingContact,
  formatPlannedVisitsFlag,
  type FinishVisitIntent,
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

const isMyVisitLine = (line: string): boolean => /^(мій запис|my visit)$/i.test(line.trim());

const isGreetingOrMainMenuLine = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    /^(головне меню|main menu)$/i.test(trimmed) ||
    /^(привіт|вітаю|hi|hello)(?:[\s,!.?…:]|$)/iu.test(trimmed)
  );
};

/** Patient asks what is booked — not greetings/thanks that never mention visits. */
const humanAsksAboutVisits = (line: string): boolean =>
  /(?:мій запис|my visit|які?\s+(?:в\s+мене\s+)?візит|мо[їи]\s+візит|запланован\w*\s+візит|what\s+(?:visits?|appointments?)\s+(?:do\s+i\s+have|have\s+i)|(?:my|upcoming)\s+(?:visit|appointment)s?)/i
    .test(line.trim());

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

/** Full latest human message (all lines) — for intent regexes, not exact chip labels. */
const lastHumanTextFromMessages = (messages: BaseMessage[]): string => {
  const lastHuman = [...messages].reverse().find((m) => m instanceof HumanMessage);
  if (!lastHuman) {
    return "";
  }
  return extractMessageTextContent(lastHuman.content).trim();
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

  // Alternative-date wording may be free text in the patient's language rather
  // than an exact Ukrainian keyboard label. Keep it in Booking while a snapshot
  // exists so agent-loop can derive the cursor deterministically.
  if (agentId === BOOKING_AGENT_ID && (state.availabilityContext != null || state.availabilityCursor != null)) {
    const availabilityRequest = resolveAvailabilityRequest(humanText, kyivToday());
    if (
      isOtherDateReply(humanText)
      || availabilityRequest?.kind === "exact"
      || availabilityRequest?.kind === "earlier"
      || availabilityRequest?.kind === "later"
      || availabilityRequest?.kind === "nearest"
    ) {
      return true;
    }
  }

  const labels = replyButtonLabels(state.lastHandoff.replyButtons);
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

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const OTHER_DATE_PATTERN = new RegExp(
  `(?:${[OTHER_DATE_LABEL, OTHER_DATE_LABEL_EN].map(escapeRegExp).join("|")}|інша\\s*дат|another\\s*date)`,
  "i",
);
const RUSSIAN_OTHER_DATE_PATTERN =
  /^(?:другая|другой|другую|другие)(?:\s+(?:дата|дату|даты|день|дни|вариант(?:ы)?))?$/i;

const isOtherDateReply = (human: string): boolean =>
  OTHER_DATE_PATTERN.test(human) || RUSSIAN_OTHER_DATE_PATTERN.test(human.trim());

/** Cancel / reschedule paraphrases (not only exact chip labels). */
const VISIT_CHANGE_INTENT =
  /(?:скасува\w*|перенес\w*|cancel(?:l?ing|led|lation)?|reschedul\w*)/i;

const isDayOrTimeReply = (human: string): boolean =>
  resolveAvailabilityRequest(human, kyivToday()) != null
  || /\b\d{1,2}:\d{2}\b/.test(human)
  || isOtherDateReply(human);

const isVisitChangeIntent = (human: string): boolean =>
  VISIT_CHANGE_INTENT.test(human)
  || VISIT_CHANGE_ROUTE_LABELS.has(human.trim());

/**
 * Default-to-FAQ after a consultation / book-this-procedure yes/no when the reply
 * is not owned by booking (Так, consultation request, day/time, visit-change, phone).
 * Not a named-procedure detector — leftover free text after an offer goes to FAQ
 * so booking cannot silently attach consultation slots without catalog chips.
 */
export const shouldRouteProcedureBrowseToFaq = (state: ClinicState): boolean => {
  const handoff = state.lastHandoff;
  if (
    (handoff?.agentId !== BOOKING_AGENT_ID && handoff?.agentId !== FAQ_AGENT_ID)
    || handoff.status !== "ok"
  ) {
    return false;
  }
  const offerText = handoff.replyText ?? "";
  if (!isBookingOfferQuestion(offerText)) {
    return false;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const humanLine = lastHumanLineFromMessages(state.messages);
  if (!human || SUPERVISOR_OWNED_REPLY_LABELS.has(humanLine)) {
    return false;
  }
  if (isYesReply(human) || requestsConsultation(human)) {
    return false;
  }
  if (isVisitChangeIntent(human) || normalizeClinicPhone(human) != null) {
    return false;
  }
  // After book-this-procedure, a day/time is agreement to book that CRM row.
  // After a consultation offer, day/time still belongs to booking (slots), not FAQ.
  if (isDayOrTimeReply(human)) {
    return false;
  }
  return true;
};

/** @deprecated Use shouldRouteProcedureBrowseToFaq */
export const shouldRouteNamedProcedureToFaq = shouldRouteProcedureBrowseToFaq;

/**
 * Mid-booking ladder (DATE/TIME/details), naming a catalog procedure is a browse
 * intent, not a booking step. Booking has no catalog keyboard, so it would answer
 * with a chip-less CRM list and could book a service the patient never confirmed.
 */
export const shouldRouteCatalogMentionToFaq = (state: ClinicState): boolean => {
  const handoff = state.lastHandoff;
  if (handoff?.agentId !== BOOKING_AGENT_ID || handoff.status !== "ok") {
    return false;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const humanLine = lastHumanLineFromMessages(state.messages);
  if (!human || SUPERVISOR_OWNED_REPLY_LABELS.has(humanLine)) {
    return false;
  }
  if (isYesReply(human) || requestsConsultation(human)) {
    return false;
  }
  if (isVisitChangeIntent(human) || normalizeClinicPhone(human) != null) {
    return false;
  }
  if (isDayOrTimeReply(human)) {
    return false;
  }
  const names = (state.servicesContext?.list ?? []).map((service) => service.name);
  return mentionsCatalogProcedure(human, names);
};

/**
 * Catalog-browse fallback: FAQ chip sticky is exact taps only. Free text during
 * that browse (e.g. naming another family) otherwise goes to booking, which has
 * no catalog keyboard — keep FAQ unless the reply is owned (Так, visit-change, phone).
 */
export const shouldStayInFaqCatalog = (state: ClinicState): boolean => {
  const handoff = state.lastHandoff;
  if (handoff?.agentId !== FAQ_AGENT_ID || handoff.status !== "ok") {
    return false;
  }
  if (handoff.yieldToSupervisor) {
    return false;
  }
  const human = lastHumanTextFromMessages(state.messages);
  const humanLine = lastHumanLineFromMessages(state.messages);
  if (!human || SUPERVISOR_OWNED_REPLY_LABELS.has(humanLine)) {
    return false;
  }
  if (isYesReply(human) || isVisitChangeIntent(human) || normalizeClinicPhone(human) != null) {
    return false;
  }
  const labels = replyButtonLabels(handoff.replyButtons);
  if (labels.length === 0 || labels.includes(human) || labels.includes(humanLine)) {
    return false;
  }
  return true;
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
    const hasVisit = (bookingContext?.meetings.length ?? 0) > 0;
    const lastHumanLine = lastHumanLineFromMessages(state.messages);
    const wantsVisitChange =
      hasVisit && (isMyVisitLine(lastHumanLine) || humanAsksAboutVisits(lastHumanLine));

    const normalizedReply = normalizeSupervisorReply(decision.reply);
    if (!normalizedReply) {
      const last = state.messages[state.messages.length - 1];
      if (last instanceof AIMessage && state.lastHandoff) {
        return {
          next: FINISH_ROUTE,
          lastHandoff: null,
        };
      }
      // «Мій запис» body is code-owned — empty model reply is OK when prefetch has visits.
      if (!wantsVisitChange) {
        return routingFailureUpdate("FINISH without reply");
      }
    }

    // Strip any stray model trailer; code owns FINISH keyboards and visit lines from
    // human intent + bookingContext. VISIT CHANGE only when they asked about visits —
    // ignore model menu=visit_change on greetings / «Головне меню».
    const text = normalizedReply ? extractReplyButtons(normalizedReply).text : "";
    const visitIntent: FinishVisitIntent = wantsVisitChange
      ? "visit_ask"
      : isGreetingOrMainMenuLine(lastHumanLine)
        ? "greeting"
        : "other";
    const replyText = attachPrefetchVisits(text, bookingContext, visitIntent);
    let replyButtons: string[];
    if (wantsVisitChange) {
      replyButtons = [...VISIT_CHANGE_MENU];
      if (decision.menu == null) {
        trackEvent("reply_menu_filled", { menu: "visit_change", reason: "omitted" });
      }
    } else {
      replyButtons = [...defaultMenuLabels(hasVisit)];
    }

    return {
      next: FINISH_ROUTE,
      lastHandoff: {
        agentId: FINISH_ROUTE,
        agentName: "supervisor",
        status: "ok",
        replyText,
        replyButtons,
      },
      messages: [new AIMessage(replyText)],
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
    // These labels must always refetch — reminder HITL does not set prefetchDirty.
    const forcePrefetch = /^(мій запис|my visit|головне меню|main menu|скасувати|cancel)$/i.test(
      lastHumanLine,
    );
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
        // Prefetch refreshes contact/meetings only — keep slot + note unless they left book-this-slot.
        // Always drop availability so DATE/TIME rewrite stays owned by finalize.
        const resetBookingLadder =
          isGreetingOrMainMenuLine(lastHumanLine)
          || isMyVisitLine(lastHumanLine)
          || (/^(скасувати|cancel)$/i.test(lastHumanLine) && state.selectedSlot == null);
        prefetchUpdate = {
          ...prefetched,
          prefetchDirty: false,
          prefetchFetchedAt: Date.now(),
          availabilityContext: null,
          availabilityCursor: resetBookingLadder
            ? null
            : state.availabilityCursor ?? availabilityCursorFromContext(state.availabilityContext),
          ...(resetBookingLadder
            ? {
              bookingNoteStatus: "unasked" as const,
              selectedSlot: null,
              selectedAvailabilityDate: null,
            }
            : state.selectedSlot == null
              ? { selectedAvailabilityDate: null }
              : {}),
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

    if (
      shouldRouteProcedureBrowseToFaq(state)
      || shouldStayInFaqCatalog(state)
      || shouldRouteCatalogMentionToFaq(state)
    ) {
      return {
        next: FAQ_AGENT_ID,
        lastHandoff: null,
        ...prefetchUpdate,
        availabilityContext: null,
        availabilityCursor: null,
        ...(state.selectedAvailabilityDate != null
          ? { selectedAvailabilityDate: null }
          : {}),
      };
    }

    const dynamic = [
      options.buildSupervisorDynamicContext?.().trim() ?? "",
      formatGreetingContact(contactContext),
      formatPlannedVisitsFlag(bookingContext),
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

    const routed = resolveRoutingDecision(decision, state, enabledIds, bookingContext);
    // Drop paged DATE snapshot unless this is in-booking free text (not an owned menu label).
    const keepAvailability =
      state.lastHandoff?.agentId === BOOKING_AGENT_ID
      && routed.next === BOOKING_AGENT_ID
      && !SUPERVISOR_OWNED_REPLY_LABELS.has(lastHumanLine);

    return {
      ...routed,
      ...prefetchUpdate,
      ...(keepAvailability
        ? {}
        : {
          availabilityContext: null,
          availabilityCursor: null,
          ...(state.selectedAvailabilityDate != null
            ? { selectedAvailabilityDate: null }
            : {}),
        }),
    };
  };
};

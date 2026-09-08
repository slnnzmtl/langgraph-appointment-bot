import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
} from "@personal-assistant/llm-gemini";

import { stripToolNoiseFromMessages } from "./supervisor-history.js";
import type { SupervisorContextCacheOptions } from "./supervisor.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "./tool-routing.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type BookingNoteStatus,
  type ClinicAgentDefinition,
  type ClinicHandoffStatus,
  type SelectedBookingSlot,
} from "./types.js";
import {
  normalizePresentAvailabilityResult,
  tryAvailabilityCacheHit,
  type AvailabilityContext,
  type AvailabilitySlotsToolArgs,
} from "../tools/availability-tools.js";
import { shortDayMonthLabel } from "../tools/availability-slots.js";
import {
  normalizeListServicesResult,
  type ServicesContext,
} from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";
import { trackEvent } from "../analytics/track.js";
import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_OFFER_MENU,
  BOOKING_REPLACE_MENU,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import { asJsonRecord } from "../shared/json-record.js";
import {
  catalogChoiceButtonsFromText,
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
  isBookingOfferReply,
} from "../shared/message-content.js";
import {
  formatBookingMeetingsContext,
  formatContactContext,
  formatPlannedVisitsFlag,
  formatSelectedSlotContext,
  formatServicesContext,
} from "./context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import {
  isModelFailureMessage,
  tagModelFailureMessage,
  tagRuntimeAgentMessage,
} from "./sub-agent-messages.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;
export const llmNodeName = (agentId: string): string => `${agentId}__llm`;
export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;
export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

export type CreateAgentLoopOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  contextCache?: SupervisorContextCacheOptions;
};

/** CRM writes that invalidate checkpointed contact/meetings prefetch. */
const PREFETCH_INVALIDATING_TOOLS = new Set([
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

const MEETING_MUTATION_TOOLS = new Set([
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

const BLOCKED_MEETING_ERRORS = new Set([
  "Contact incomplete",
  "Already booked",
  "Not authorized",
  "Note step required",
]);

export type MeetingMutationOutcome = "committed" | "pending" | "blocked" | "failed" | null;

export const classifyMeetingMutationToolMessage = (
  message: ToolMessage,
): MeetingMutationOutcome => {
  const name = message.name;
  if (!name || !MEETING_MUTATION_TOOLS.has(name)) {
    return null;
  }
  const body = extractMessageTextContent(message.content).trim();
  if (body.startsWith("Error:")) {
    return "failed";
  }
  const record = asJsonRecord(body);
  if (!record) {
    return "committed";
  }
  if (record.cancelled === true || record.awaitingConfirmation === true) {
    return "pending";
  }
  if (typeof record.error === "string") {
    return BLOCKED_MEETING_ERRORS.has(record.error) ? "blocked" : "failed";
  }
  return "committed";
};

const meetingMutationIsHitlDecline = (message: ToolMessage): boolean =>
  MEETING_MUTATION_TOOLS.has(message.name ?? "")
  && asJsonRecord(extractMessageTextContent(message.content).trim())?.cancelled === true;

/** Committed, failed, or HITL ❌ — stale free/busy and note step must not survive. */
export const meetingMutationClearsAvailability = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    return outcome === "committed" || outcome === "failed" || meetingMutationIsHitlDecline(message);
  });

const toolMessageName = (message: BaseMessage): string | undefined => {
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
};

/** True when a ToolMessage for this tool is already in the current agent turn. */
const toolRanThisTurn = (messages: BaseMessage[], toolName: string): boolean =>
  messages.some(
    (message) => message instanceof ToolMessage && toolMessageName(message) === toolName,
  );

export const captureLatestToolContext = <T>(
  messages: BaseMessage[],
  toolName: string,
  normalize: (raw: string) => T | null,
): T | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || toolMessageName(message) !== toolName) {
      continue;
    }
    return normalize(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
};

export const captureAvailabilityFromMessages = (
  messages: BaseMessage[],
): AvailabilityContext | null | undefined =>
  captureLatestToolContext(messages, "present_availability_slots", normalizePresentAvailabilityResult);

export const captureServicesFromMessages = (
  messages: BaseMessage[],
): ServicesContext | null | undefined =>
  captureLatestToolContext(messages, "list_services", normalizeListServicesResult);

/** DATE offer from a multi-day availability snapshot (code-owned when the model invents hours). */
export const formatAvailabilityDateOffer = (
  days: AvailabilityContext["days"],
): { replyText: string; replyButtons: string[] } => {
  const open = days.filter((day) => day.slots.length > 0).slice(0, 3);
  const bullets = open
    .map((day) => {
      const dayPart = day.dayLabel ?? day.date;
      const hours = day.slots.map((slot) => slot.label).join(", ");
      return `  - ${dayPart}: ${hours}`;
    })
    .join("\n");
  return {
    replyText: `Найближчі вільні дні 🗓️\n\n${bullets}\n\nЯкий день вам зручний?`,
    replyButtons: [
      ...open.map((day) => shortDayMonthLabel(day.dayLabel ?? day.date)),
      OTHER_DATE_LABEL,
    ],
  };
};

/** TIME offer from a single-day availability snapshot. */
export const formatAvailabilityTimeOffer = (
  day: AvailabilityContext["days"][number],
): { replyText: string; replyButtons: string[] } => {
  const dayLabel = day.dayLabel ?? day.date;
  const labels = day.slots.map((slot) => slot.label);
  const bullets = labels.map((label) => `  - ${label}`).join("\n");
  return {
    replyText: `Вільні години на ${dayLabel} 🗓️\n\n${bullets}\n\nЯкий час вам зручний?`,
    replyButtons: [...labels.slice(0, 3), OTHER_DATE_LABEL],
  };
};

const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

/** Match a patient day pick to a snapshot day (keyboard short label, dayLabel, or YYYY-MM-DD). */
export const matchAvailabilityDay = (
  humanText: string,
  days: AvailabilityContext["days"],
): AvailabilityContext["days"][number] | null => {
  const trimmed = humanText.trim();
  if (!trimmed || trimmed === OTHER_DATE_LABEL) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  for (const day of days) {
    if (day.slots.length === 0) {
      continue;
    }
    const dayLabel = day.dayLabel ?? day.date;
    const short = shortDayMonthLabel(dayLabel);
    if (
      trimmed === day.date
      || trimmed === dayLabel
      || trimmed === short
      || normalized === dayLabel.toLowerCase()
      || normalized === short.toLowerCase()
    ) {
      return day;
    }
  }
  return null;
};

const clockKey = (text: string): string | null => {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    return null;
  }
  return `${Number(match[1])}:${match[2] ?? "00"}`;
};

/** Match a patient clock-time pick to a snapshot slot (label, HH:mm, or bare hour). */
export const matchAvailabilitySlot = (
  humanText: string,
  availabilityContext: AvailabilityContext | null | undefined,
): SelectedBookingSlot | null => {
  if (!availabilityContext || availabilityContext.days.length === 0) {
    return null;
  }
  const trimmed = humanText.trim();
  if (!trimmed || trimmed === OTHER_DATE_LABEL) {
    return null;
  }
  const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
  const wantClock = clockKey(normalized);
  for (const day of availabilityContext.days) {
    for (const slot of day.slots) {
      const labelNorm = slot.label.trim().toLowerCase().replace(/\s+/g, "");
      if (normalized === labelNorm || (wantClock != null && clockKey(labelNorm) === wantClock)) {
        return { dateStart: slot.dateStart, dateEnd: slot.dateEnd, label: slot.label };
      }
    }
  }
  return null;
};

const NOTE_SKIP_REPLIES = new Set(
  [
    INTENT_SKIP_LABEL,
    INTENT_SKIP_LABEL_EN,
    "no",
    "ні",
    "нет",
    "без коментаря",
    "без коментарів",
    "не треба",
    "не потрібно",
    "skip",
  ].map((label) => label.toLowerCase()),
);

const isNoteSkipReply = (humanText: string): boolean =>
  NOTE_SKIP_REPLIES.has(humanText.trim().toLowerCase());

const noteStepBlocksCreate = (status: BookingNoteStatus | null | undefined): boolean =>
  status !== "skipped" && status !== "answered";

const CREATE_NOTE_REQUIRED_ERROR = "Note step required";

/**
 * Advance / reset the note ladder from the latest human line before the booking LLM runs.
 * Always ask once after a time pick — even if they named a procedure earlier.
 */
export const advanceBookingNoteStep = (state: ClinicState): ClinicStateUpdate => {
  const human = lastHumanText(state.messages);
  if (!human || human === MAIN_MENU_LABEL) {
    return {};
  }
  const status = state.bookingNoteStatus ?? "unasked";
  const availability = state.availabilityContext;
  const matchedSlot = matchAvailabilitySlot(human, availability);
  const matchedDay = matchAvailabilityDay(human, availability?.days ?? []);

  const sameSlot =
    matchedSlot != null
    && state.selectedSlot != null
    && state.selectedSlot.dateStart === matchedSlot.dateStart;

  if (status === "awaiting") {
    if (isNoteSkipReply(human) || sameSlot) {
      trackEvent("booking_note_step", { phase: "skipped" });
      return { bookingNoteStatus: "skipped" };
    }
    if (matchedSlot) {
      trackEvent("booking_note_step", { phase: "awaiting" });
      return { bookingNoteStatus: "awaiting", selectedSlot: matchedSlot };
    }
    if (matchedDay) {
      return { bookingNoteStatus: "unasked", selectedSlot: null };
    }
    trackEvent("booking_note_step", { phase: "answered" });
    return { bookingNoteStatus: "answered" };
  }

  if (matchedSlot && (status === "unasked" || !sameSlot)) {
    trackEvent("booking_note_step", { phase: "awaiting" });
    return { bookingNoteStatus: "awaiting", selectedSlot: matchedSlot };
  }

  if (matchedDay && (status === "skipped" || status === "answered")) {
    return { bookingNoteStatus: "unasked", selectedSlot: null };
  }

  return {};
};

const resetBookingNoteState = (): ClinicStateUpdate => ({
  bookingNoteStatus: "unasked",
  selectedSlot: null,
});

/**
 * When present_availability_slots ran this turn, replace invented DATE/TIME copy with the
 * snapshot. Multi-day → DATE; one day → TIME. Returns null when this turn is not a slot offer.
 */
export const availabilityOfferFromToolTurn = (
  messages: BaseMessage[],
): { replyText: string; replyButtons: string[] } | null => {
  if (!toolRanThisTurn(messages, "present_availability_slots")) {
    return null;
  }
  const captured = captureAvailabilityFromMessages(messages);
  if (!captured) {
    return null;
  }
  const open = captured.days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return null;
  }
  if (open.length === 1) {
    return formatAvailabilityTimeOffer(open[0]!);
  }
  return formatAvailabilityDateOffer(open);
};

/**
 * Code-owned DATE/TIME for booking finalize: prefer this-turn tool snapshot; else TIME when
 * the latest human message picks a day already in checkpointed availabilityContext.
 */
export const resolveAvailabilityOffer = (
  messages: BaseMessage[],
  availabilityContext: AvailabilityContext | null | undefined,
): { replyText: string; replyButtons: string[] } | null => {
  const fromTool = availabilityOfferFromToolTurn(messages);
  if (fromTool) {
    return fromTool;
  }
  if (!availabilityContext || availabilityContext.days.length === 0) {
    return null;
  }
  const day = matchAvailabilityDay(lastHumanText(messages), availabilityContext.days);
  if (!day) {
    return null;
  }
  return formatAvailabilityTimeOffer(day);
};

export const crmWriteDirtiesPrefetch = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const name = message.name;
    if (!name || !PREFETCH_INVALIDATING_TOOLS.has(name)) {
      return false;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return false;
    }
    const record = asJsonRecord(body);
    if (!record) {
      return true;
    }
    if (typeof record.error === "string") {
      return name === "cancel_meeting";
    }
    return record.cancelled !== true && record.awaitingConfirmation !== true;
  });

/** Latest this-turn create_meeting JSON `error`, or undefined. */
const latestCreateMeetingError = (messages: BaseMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return undefined;
    }
    const record = asJsonRecord(body);
    return typeof record?.error === "string" ? record.error : undefined;
  }
  return undefined;
};

export const createMeetingAlreadyBooked = (messages: BaseMessage[]): boolean =>
  latestCreateMeetingError(messages) === "Already booked";

const SLOT_JUST_TAKEN_PREFIX = "На жаль, обраний час щойно зайняли.\n\n";

/** Meeting id from a committed cancel_meeting result or its tool_call args. */
const cancelledMeetingIdFromTurn = (
  messages: BaseMessage[],
  cancelResult: ToolMessage,
): string | undefined => {
  const record = asJsonRecord(extractMessageTextContent(cancelResult.content).trim());
  if (typeof record?.id === "string" && record.id.length > 0) {
    return record.id;
  }
  if (typeof record?.meetingId === "string" && record.meetingId.length > 0) {
    return record.meetingId;
  }
  const callId = cancelResult.tool_call_id;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (call.name !== "cancel_meeting") {
        continue;
      }
      if (callId && call.id != null && call.id !== callId) {
        continue;
      }
      const meetingId = (call.args as { meetingId?: unknown } | undefined)?.meetingId;
      if (typeof meetingId === "string" && meetingId.length > 0) {
        return meetingId;
      }
    }
  }
  return undefined;
};

/**
 * DEFAULT MENU hasVisit for booking finalize: committed create → true; committed cancel →
 * remaining meetings after dropping that id; else checkpointed bookingContext.
 */
export const defaultMenuHasVisit = (
  messages: BaseMessage[],
  bookingContext: BookingContext | null | undefined,
): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !(message instanceof ToolMessage)
      || (message.name !== "create_meeting" && message.name !== "cancel_meeting")
    ) {
      continue;
    }
    if (classifyMeetingMutationToolMessage(message) !== "committed") {
      return (bookingContext?.meetings.length ?? 0) > 0;
    }
    if (message.name === "create_meeting") {
      return true;
    }
    const cancelledId = cancelledMeetingIdFromTurn(messages, message);
    const remaining = (bookingContext?.meetings ?? []).filter((m) => m.id !== cancelledId);
    return remaining.length > 0;
  }
  return (bookingContext?.meetings.length ?? 0) > 0;
};

const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (isModelFailureMessage(message)) {
    return "error";
  }

  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

export const createAgentPrepareNode = (agentId: string) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
      stepCount: 0,
    };
    if (agentId === BOOKING_AGENT_ID) {
      Object.assign(update, advanceBookingNoteStep(state));
    }
    return update;
  };

export const createAgentLlmNode = (options: CreateAgentLoopOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;
  const cache = options.contextCache;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);
  const displayName = cache?.displayName ?? `clinic-${agent.id}`;

  const invokeUncached = async (
    staticPrompt: string,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) =>
    boundModel.invoke(buildUncachedMessages(staticPrompt, dynamic, history), config);

  const invokeCached = async (
    handle: ContextCacheHandle,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) => {
    const cachedModel = createCachedGeminiModel(cache!.apiKey, cache!.modelName, handle);
    // Tools and system instruction live in CachedContent — must not be sent again on generateContent.
    return cachedModel.invoke(buildCachedMessages(dynamic, history), config);
  };

  const cacheSpec = (staticPrompt: string) => ({
    modelName: cache!.modelName,
    staticSystemInstruction: staticPrompt,
    tools,
    displayName,
  });

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    if (hasPendingToolCalls(state.agentMessages)) {
      return { stepCount: state.stepCount };
    }

    const last = state.agentMessages[state.agentMessages.length - 1];
    const isContinuation = last instanceof ToolMessage;
    const stepCount = isContinuation ? state.stepCount + 1 : 1;

    const staticPrompt = agent.systemPrompt.trim();
    const dynamicParts = [
      formatSystemMetadata(new Date(), { runtimeAgent: agent.name }).trim(),
      agent.id === BOOKING_AGENT_ID ? formatContactContext(state.contactContext) : "",
      agent.id === BOOKING_AGENT_ID
        ? formatBookingMeetingsContext(state.bookingContext)
        : formatPlannedVisitsFlag(state.bookingContext),
    ];
    // Full days[] lives in the slots tool result / checkpoint — do not also bill Gemini for it.
    // After a time pick, pass only the matched ISO slot for create_meeting.
    if (agent.id === BOOKING_AGENT_ID) {
      dynamicParts.push(formatSelectedSlotContext(state.selectedSlot));
    }
    const bookingHasAvailabilityDays =
      (state.availabilityContext?.days.length ?? 0) > 0;
    if (
      (agent.id === FAQ_AGENT_ID || agent.id === BOOKING_AGENT_ID)
      && !toolRanThisTurn(state.agentMessages, "list_services")
      && !(agent.id === BOOKING_AGENT_ID && bookingHasAvailabilityDays)
    ) {
      dynamicParts.push(formatServicesContext(state.servicesContext));
    }
    const dynamic = dynamicParts.filter((part) => part.length > 0).join("\n\n");

    try {
      let handle: ContextCacheHandle | null = null;
      if (cache) {
        handle = await cache.manager.getOrCreate(cacheSpec(staticPrompt));
      }

      let response: AIMessage;
      if (handle) {
        try {
          response = (await invokeCached(
            handle,
            dynamic,
            state.agentMessages,
            config,
          )) as AIMessage;
        } catch (error) {
          if (!isCachedContentNotFoundError(error)) {
            throw error;
          }
          cache!.manager.invalidate(handle.cacheName);
          const recreated = await cache!.manager.getOrCreate(cacheSpec(staticPrompt));
          response = (recreated
            ? await invokeCached(recreated, dynamic, state.agentMessages, config)
            : await invokeUncached(staticPrompt, dynamic, state.agentMessages, config)) as AIMessage;
        }
      } else {
        response = (await invokeUncached(
          staticPrompt,
          dynamic,
          state.agentMessages,
          config,
        )) as AIMessage;
      }

      return {
        agentMessages: [response],
        stepCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[clinic-${agent.id}] model call failed:`, message);
      return {
        agentMessages: [tagModelFailureMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE))],
        stepCount,
      };
    }
  };
};

export const createAgentToolsNode = (
  tools: StructuredToolInterface[],
  agentId?: string,
) => {
  const toolNode = new ToolNode(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const agentMessages = state.agentMessages ?? [];
    let lastAiIndex = -1;
    for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
      const message = agentMessages[index];
      if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
        lastAiIndex = index;
        break;
      }
    }

    const synthetic: ToolMessage[] = [];
    const remainingCalls: NonNullable<AIMessage["tool_calls"]> = [];
    let noteStatusUpdate: ClinicStateUpdate = {};

    if (lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      for (const call of lastAi.tool_calls ?? []) {
        if (
          agentId === BOOKING_AGENT_ID
          && call.name === "create_meeting"
          && noteStepBlocksCreate(state.bookingNoteStatus)
        ) {
          noteStatusUpdate = { bookingNoteStatus: "awaiting" };
          trackEvent("booking_create_blocked_note", {
            phase: state.bookingNoteStatus ?? "unasked",
          });
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: CREATE_NOTE_REQUIRED_ERROR,
                hint:
                  "Ask the optional visit-note question once (STEP INTENT) with the skip shortcut. Do not call create_meeting until the patient skips, declines, or shares a note.",
              }),
              tool_call_id: call.id ?? "",
              name: "create_meeting",
            }),
          );
          continue;
        }

        if (call.name === "present_availability_slots") {
          const args = (call.args ?? {}) as AvailabilitySlotsToolArgs;
          const hit = tryAvailabilityCacheHit(state.availabilityContext, args);
          if (hit) {
            trackEvent("availability_cache_hit", {
              outcome: "success",
              kind: hit.kind,
              ...(typeof args.date === "string" ? { date: args.date } : {}),
            });
            synthetic.push(
              new ToolMessage({
                content: hit.json,
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
        }

        remainingCalls.push(call);
      }
    }

    let toolResultMessages: BaseMessage[] = [];
    if (remainingCalls.length > 0 && lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      const originalCalls = lastAi.tool_calls ?? [];
      const messagesForTools =
        remainingCalls.length === originalCalls.length
          ? agentMessages
          : [
              ...agentMessages.slice(0, lastAiIndex),
              new AIMessage({
                content: lastAi.content,
                tool_calls: remainingCalls,
                additional_kwargs: lastAi.additional_kwargs,
                response_metadata: lastAi.response_metadata,
                id: lastAi.id,
              } as ConstructorParameters<typeof AIMessage>[0]),
              ...agentMessages.slice(lastAiIndex + 1),
            ];
      const result = await (
        toolNode as unknown as {
          run(
            input: { messages: BaseMessage[] },
            config?: RunnableConfig,
          ): Promise<{ messages: BaseMessage[] }>;
        }
      ).run({ messages: messagesForTools }, config);
      toolResultMessages = result.messages;
    }

    const resultMessages = [...synthetic, ...toolResultMessages];
    const update: ClinicStateUpdate = {
      agentMessages: resultMessages,
      ...noteStatusUpdate,
    };

    if (meetingMutationClearsAvailability(resultMessages)) {
      update.availabilityContext = null;
      Object.assign(update, resetBookingNoteState());
      if (
        resultMessages.some(
          (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
        )
      ) {
        trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
      }
    } else {
      const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
      if (capturedAvailability !== undefined) {
        update.availabilityContext = capturedAvailability;
      }
    }

    const capturedServices = captureServicesFromMessages(resultMessages);
    if (capturedServices !== undefined) {
      update.servicesContext = capturedServices;
    }

    if (crmWriteDirtiesPrefetch(resultMessages)) {
      update.prefetchDirty = true;
    }

    return update;
  };
};

export const createAgentFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState): ClinicStateUpdate => {
    const agentMessages = state.agentMessages ?? [];
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
    };

    if (!(lastMessage instanceof AIMessage)) {
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(tagged.content);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(rawText);
    let replyText = text.trim();
    let replyButtons: string[] = [];
    let yieldFlag = false;

    // Model failure: deliver via handoff only — do not persist into conversation history.
    if (status === "error" && isModelFailureMessage(tagged)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "error",
          replyText: PATIENT_FALLBACK_MESSAGE,
          ...(agent.id === BOOKING_AGENT_ID
            ? { replyButtons: [...defaultMenuLabels(hasVisit)] }
            : {}),
        },
      };
    }

    // Already booked wins over DATE/TIME rewrite when both fire in the same turn.
    const alreadyBooked =
      agent.id === BOOKING_AGENT_ID && createMeetingAlreadyBooked(agentMessages);
    const createError = latestCreateMeetingError(agentMessages);
    const noteBlockedThisTurn = createError === CREATE_NOTE_REQUIRED_ERROR;
    const awaitingNote =
      agent.id === BOOKING_AGENT_ID
      && (state.bookingNoteStatus === "awaiting" || noteBlockedThisTurn)
      && !alreadyBooked;
    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer =
      agent.id === BOOKING_AGENT_ID && !alreadyBooked
        ? resolveAvailabilityOffer(agentMessages, state.availabilityContext)
        : null;
    if (slotOffer) {
      replyText =
        createError != null && !noteBlockedThisTurn
          ? `${SLOT_JUST_TAKEN_PREFIX}${slotOffer.replyText}`
          : slotOffer.replyText;
      replyButtons = slotOffer.replyButtons;
    } else if (awaitingNote) {
      // Code-own INTENT skip (DDD-48); force the note question when create was blocked (DDD-49/51).
      if (noteBlockedThisTurn || replyText.length === 0) {
        replyText = BOOKING_NOTE_QUESTION_UK;
      }
      replyButtons = [INTENT_SKIP_LABEL];
      trackEvent("reply_menu_filled", { menu: "intent_skip", reason: "code_owned" });
    } else if (alreadyBooked) {
      replyButtons = [...BOOKING_REPLACE_MENU];
    } else if (replyText.length > 0 && isBookingOfferReply(replyText)) {
      replyButtons = [...BOOKING_OFFER_MENU];
      if (agent.id === FAQ_AGENT_ID) {
        yieldFlag = true;
      }
      trackEvent("reply_menu_filled", { menu: "booking_offer", reason: "code_owned" });
    } else if (agent.id === FAQ_AGENT_ID && replyText.length > 0) {
      replyButtons = catalogChoiceButtonsFromText(replyText);
      if (replyButtons.length === 0) {
        // Accidental leftover trailer only — never the adapter markup channel.
        replyButtons = accidentalButtons;
      }
    } else if (agent.id === BOOKING_AGENT_ID && replyText.length > 0) {
      const hasVisit = defaultMenuHasVisit(agentMessages, state.bookingContext);
      replyButtons = [...defaultMenuLabels(hasVisit)];
    }

    if (yieldTag && agent.id === FAQ_AGENT_ID) {
      yieldFlag = true;
    }

    const noteStatusForHandoff =
      awaitingNote && !slotOffer
        ? ({ bookingNoteStatus: "awaiting" as const } satisfies ClinicStateUpdate)
        : {};

    const replyMessage =
      replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || slotOffer != null
        ? new AIMessage({
            content: replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(replyText.length > 0 ? { replyText } : {}),
      ...(replyButtons.length > 0 ? { replyButtons } : {}),
      ...(yieldFlag ? { yieldToSupervisor: true } : {}),
    };

    if (status === "empty") {
      return { ...cleared, lastHandoff, ...noteStatusForHandoff };
    }

    if (status === "max_steps") {
      if (replyText.length === 0) {
        console.error(
          `[clinic-${agent.id}] exceeded the maximum of ${agent.maxSteps} tool steps.`,
        );
      }
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        messages: [
          replyText.length > 0
            ? replyMessage
            : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
      ...noteStatusForHandoff,
      messages: [replyMessage],
    };
  };

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
): string => {
  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  return llmName;
};

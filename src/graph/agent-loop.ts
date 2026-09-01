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
  type ClinicAgentDefinition,
  type ClinicHandoffStatus,
} from "./types.js";
import {
  normalizePresentAvailabilityResult,
  type AvailabilityContext,
} from "../tools/availability-tools.js";
import { shortDayMonthLabel } from "../tools/availability-slots.js";
import {
  normalizeListServicesResult,
  type ServicesContext,
} from "../tools/service-tools.js";
import {
  BOOKING_REPLACE_MENU,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import { asJsonRecord } from "../shared/json-record.js";
import {
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
} from "../shared/message-content.js";
import {
  formatAvailabilityContext,
  formatBookingMeetingsContext,
  formatContactContext,
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

export const meetingMutationClearsAvailability = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    return outcome === "committed" || outcome === "failed";
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
      return false;
    }
    return record.cancelled !== true && record.awaitingConfirmation !== true;
  });

export const createMeetingAlreadyBooked = (messages: BaseMessage[]): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return false;
    }
    const record = asJsonRecord(body);
    return record?.error === "Already booked";
  }
  return false;
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

export const createAgentPrepareNode = () =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => ({
    agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
    stepCount: 0,
  });

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
      formatContactContext(state.contactContext),
      formatBookingMeetingsContext(state.bookingContext),
    ];
    // Skip when the tool already ran this turn — its ToolMessage is in agentMessages.
    if (!toolRanThisTurn(state.agentMessages, "present_availability_slots")) {
      dynamicParts.push(formatAvailabilityContext(state.availabilityContext));
    }
    const bookingHasAvailabilityDays =
      (state.availabilityContext?.days.length ?? 0) > 0;
    if (
      !toolRanThisTurn(state.agentMessages, "list_services")
      && !bookingHasAvailabilityDays
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

export const createAgentToolsNode = (tools: StructuredToolInterface[]) => {
  const toolNode = new ToolNode(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const result = await (
      toolNode as unknown as {
        run(
          input: { messages: BaseMessage[] },
          config?: RunnableConfig,
        ): Promise<{ messages: BaseMessage[] }>;
      }
    ).run({ messages: state.agentMessages }, config);

    const update: ClinicStateUpdate = { agentMessages: result.messages };

    if (meetingMutationClearsAvailability(result.messages)) {
      update.availabilityContext = null;
    } else {
      const capturedAvailability = captureAvailabilityFromMessages(result.messages);
      if (capturedAvailability !== undefined) {
        update.availabilityContext = capturedAvailability;
      }
    }

    const capturedServices = captureServicesFromMessages(result.messages);
    if (capturedServices !== undefined) {
      update.servicesContext = capturedServices;
    }

    if (crmWriteDirtiesPrefetch(result.messages)) {
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
          status: "empty",
        },
      };
    }

    const status = resolveHandoffStatus(lastMessage, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(lastMessage.content);
    const { text, buttons } = extractReplyButtons(rawText);
    let replyText = text.trim();
    let replyButtons = buttons;

    // Model failure: deliver via handoff only — do not persist into conversation history.
    if (status === "error" && isModelFailureMessage(lastMessage)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          status: "error",
          replyText: PATIENT_FALLBACK_MESSAGE,
          replyButtons: [...defaultMenuLabels(hasVisit)],
        },
      };
    }

    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer = resolveAvailabilityOffer(agentMessages, state.availabilityContext);
    if (slotOffer) {
      replyText = slotOffer.replyText;
      replyButtons = slotOffer.replyButtons;
    } else if (replyButtons.length === 0 && replyText.length > 0) {
      // Empty trailer: REPLACE only — never DEFAULT MENU or BOOKING OFFER.
      if (createMeetingAlreadyBooked(agentMessages)) {
        replyButtons = [...BOOKING_REPLACE_MENU];
      }
    }

    const replyMessage =
      replyText !== extractMessageTextContent(lastMessage.content).trim()
        || buttons.length > 0
        || slotOffer != null
        ? new AIMessage({
            content: replyText,
            additional_kwargs: lastMessage.additional_kwargs,
            response_metadata: lastMessage.response_metadata,
          })
        : lastMessage;

    const lastHandoff = {
      agentId: agent.id,
      status,
      ...(replyText.length > 0 ? { replyText } : {}),
      ...(replyButtons.length > 0 ? { replyButtons } : {}),
    };

    if (status === "empty") {
      return { ...cleared, lastHandoff };
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
        messages: [
          replyText.length > 0
            ? replyMessage
            : new AIMessage(PATIENT_FALLBACK_MESSAGE),
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
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

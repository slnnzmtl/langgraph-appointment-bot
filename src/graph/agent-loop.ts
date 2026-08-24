import {
  AIMessage,
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

import { PATIENT_FALLBACK_MESSAGE } from "../shared/clinic-constants.js";
import { asJsonRecord } from "../shared/json-record.js";
import {
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
} from "../shared/message-content.js";
import {
  formatAvailabilityContext,
  formatContactContext,
  formatListedMeetingsContext,
  formatServicesContext,
} from "./context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import { tagRuntimeAgentMessage } from "./sub-agent-messages.js";
import { stripToolNoiseFromMessages } from "./supervisor-history.js";
import type { SupervisorContextCacheOptions } from "./supervisor.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "./tool-routing.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID, type ClinicAgentDefinition, type ClinicHandoffStatus } from "./types.js";
import {
  normalizePresentAvailabilityResult,
  type AvailabilityContext,
} from "../tools/availability-tools.js";
import {
  normalizeListServicesResult,
  type ServicesContext,
} from "../tools/service-tools.js";

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

export const captureAvailabilityFromMessages = (
  messages: BaseMessage[],
): AvailabilityContext | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (toolMessageName(message) !== "present_availability_slots") {
      continue;
    }
    return normalizePresentAvailabilityResult(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
};

export const captureServicesFromMessages = (
  messages: BaseMessage[],
): ServicesContext | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (toolMessageName(message) !== "list_services") {
      continue;
    }
    return normalizeListServicesResult(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
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

const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
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

export const createAgentPrepareNode = (_agentId: string) =>
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
      agent.id === BOOKING_AGENT_ID ? formatContactContext(state.contactContext) : "",
      formatListedMeetingsContext(
        state.bookingContext,
        agent.id === BOOKING_AGENT_ID ? "booking" : "faq",
      ),
    ];
    if (agent.id === BOOKING_AGENT_ID && !isContinuation) {
      dynamicParts.push(formatAvailabilityContext(state.availabilityContext));
    }
    if ((agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID) && !isContinuation) {
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
        agentMessages: [new AIMessage(PATIENT_FALLBACK_MESSAGE)],
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
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const { text, buttons } = extractReplyButtons(extractMessageTextContent(tagged.content));
    const replyMessage =
      buttons.length > 0
        ? new AIMessage({
            content: text,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;
    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(buttons.length > 0 ? { replyButtons: buttons } : {}),
    };

    if (status === "empty") {
      return { ...cleared, lastHandoff };
    }

    if (status === "max_steps") {
      const replyText = extractMessageTextContent(replyMessage.content).trim();
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
            : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
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

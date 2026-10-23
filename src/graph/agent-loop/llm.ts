import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
} from "@personal-assistant/llm-gemini";

import type { SupervisorContextCacheOptions } from "../supervisor.js";
import { hasPendingToolCalls } from "../tool-routing.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../types.js";
import { PATIENT_FALLBACK_MESSAGE } from "../../shared/clinic-constants.js";
import {
  formatBookingMeetingsContext,
  formatBookingDraftContext,
  formatContactContext,
  formatFaqCatalogChoicesContext,
  formatPlannedVisitsFlag,
  formatServicesContext,
} from "../context/context-blocks.js";
import { buildCachedMessages, buildUncachedMessages } from "../context/gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { tagModelFailureMessage } from "../context/sub-agent-messages.js";
import { toolRanThisTurn } from "./protocol/index.js";
import { sanitizeBoundModelToolCalls } from "./tool-call-coercion.js";


export type CreateAgentLlmOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  contextCache?: SupervisorContextCacheOptions;
};

export const createAgentLlmNode = (options: CreateAgentLlmOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;
  const cache = options.contextCache;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);
  const displayName = cache?.displayName ?? `clinic-${agent.id}`;
  const allowedToolNames = new Set(tools.map((tool) => tool.name));

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
    // BookingDraft is the single compact projection of the selected slot.
    if (agent.id === BOOKING_AGENT_ID) {
      dynamicParts.push(formatBookingDraftContext(state.bookingDraft));
    }
    if (
      (agent.id === FAQ_AGENT_ID || agent.id === BOOKING_AGENT_ID)
      && !toolRanThisTurn(state.agentMessages, "list_services")
    ) {
      dynamicParts.push(formatServicesContext(state.servicesContext));
    }
    if (
      agent.id === FAQ_AGENT_ID
      && state.pendingInteraction?.kind === "service_candidate"
      && state.pendingInteraction.owner === "faq"
    ) {
      dynamicParts.push(
        formatFaqCatalogChoicesContext(state.pendingInteraction.choices),
      );
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
        agentMessages: [sanitizeBoundModelToolCalls(response, allowedToolNames)],
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

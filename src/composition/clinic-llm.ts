import {
  createGeminiChatModel,
  createGeminiContextCacheManager,
  GeminiConnector,
} from "@personal-assistant/llm-gemini";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { AppConfig } from "../config.js";
import type { ILLMConnector } from "../graph/types.js";

export type ClinicLlmStack = {
  supervisorLlm: ILLMConnector;
  agentModel: BaseChatModel;
  agentModelName: string;
  contextCache: {
    manager: ReturnType<typeof createGeminiContextCacheManager>;
    apiKey: string;
    modelName: string;
    displayName: string;
  };
};

export const createClinicLlmStack = (config: AppConfig): ClinicLlmStack => {
  const supervisorLlm = new GeminiConnector(config.googleApiKey, config.supervisorModel);
  const agentModel = createGeminiChatModel(config.googleApiKey, config.agentModel);
  const contextCache = {
    manager: createGeminiContextCacheManager(
      config.googleApiKey,
      config.geminiContextCacheEnabled,
    ),
    apiKey: config.googleApiKey,
    modelName: config.supervisorModel,
    displayName: "clinic-supervisor",
  };

  return {
    supervisorLlm,
    agentModel,
    agentModelName: config.agentModel,
    contextCache,
  };
};

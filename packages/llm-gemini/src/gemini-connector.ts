import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type {
  BindRoutingToolsOptions,
  ILLMConnector,
  RoutingChain,
} from "@personal-assistant/supervisor-framework";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_GEMINI_TEMPERATURE = 0.2;

export const createGeminiChatModel = (
  apiKey: string,
  modelName: string,
  temperature = DEFAULT_GEMINI_TEMPERATURE,
): ChatGoogleGenerativeAI =>
  new ChatGoogleGenerativeAI({
    apiKey,
    model: modelName,
    temperature,
  });

export class GeminiConnector implements ILLMConnector {
  private readonly model: ChatGoogleGenerativeAI;
  private readonly apiKey: string;
  private readonly modelName: string;

  constructor(apiKey: string, modelName = DEFAULT_GEMINI_MODEL) {
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.model = createGeminiChatModel(apiKey, modelName);
  }

  getModel(): BaseChatModel {
    return this.model;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  getModelName(): string {
    return this.modelName;
  }

  bindRoutingTools<TRoute extends Record<string, unknown>>(
    schema: Parameters<ILLMConnector["bindRoutingTools"]>[0],
    options?: BindRoutingToolsOptions,
  ): RoutingChain<TRoute> {
    const model = (options?.model ?? this.model) as ChatGoogleGenerativeAI;
    return model.withStructuredOutput(schema, {
      name: "route_request",
    }) as unknown as RoutingChain<TRoute>;
  }
}

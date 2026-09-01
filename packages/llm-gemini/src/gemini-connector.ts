import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type {
  BindRoutingToolsOptions,
  ILLMConnector,
  RoutingChain,
} from "./types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_GEMINI_TEMPERATURE = 0;

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

  constructor(apiKey: string, modelName = DEFAULT_GEMINI_MODEL) {
    this.model = createGeminiChatModel(apiKey, modelName);
  }

  bindRoutingTools<TRoute extends Record<string, unknown>>(
    schema: Parameters<ILLMConnector["bindRoutingTools"]>[0],
    options?: BindRoutingToolsOptions,
  ): RoutingChain<TRoute> {
    const model = (options?.model ?? this.model) as ChatGoogleGenerativeAI;
    return model.withStructuredOutput(schema, {
      name: options?.name ?? "route_request",
    }) as unknown as RoutingChain<TRoute>;
  }
}

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

import type {
  BindRoutingToolsOptions,
  ILLMConnector,
  RoutingChain,
} from "./types.js";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_AUDIO_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_GEMINI_TEMPERATURE = 0.2;

const TRANSCRIBE_PROMPT =
  "Transcribe this voice message. Return only the spoken text in the original language. Do not translate. Do not add commentary. If there is no speech, return an empty string.";

export type TranscribeAudioInput = {
  mimeType: string;
  data: string;
};

const transcriptFromContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .join("")
    .trim();
};

export const transcribeAudio = async (
  apiKey: string,
  audio: TranscribeAudioInput,
  modelName = DEFAULT_AUDIO_MODEL,
): Promise<string> => {
  const model = createGeminiChatModel(apiKey, modelName);
  const result = await model.invoke([
    new HumanMessage({
      content: [
        { type: "text", text: TRANSCRIBE_PROMPT },
        { type: "media", mimeType: audio.mimeType, data: audio.data },
      ],
    }),
  ]);
  return transcriptFromContent(result.content);
};

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

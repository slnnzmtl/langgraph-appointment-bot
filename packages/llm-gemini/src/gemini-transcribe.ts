import { HumanMessage } from "@langchain/core/messages";

import { createGeminiChatModel } from "./gemini-connector.js";

export const DEFAULT_AUDIO_MODEL = "gemini-3.1-flash-lite";

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
  prompt = TRANSCRIBE_PROMPT,
): Promise<string> => {
  const model = createGeminiChatModel(apiKey, modelName);
  const result = await model.invoke([
    new HumanMessage({
      content: [
        { type: "text", text: prompt },
        { type: "media", mimeType: audio.mimeType, data: audio.data },
      ],
    }),
  ]);
  return transcriptFromContent(result.content);
};

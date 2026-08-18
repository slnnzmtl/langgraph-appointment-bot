import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it, vi } from "vitest";

import {
  createGeminiChatModel,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TEMPERATURE,
  GeminiConnector,
  transcribeAudio,
} from "../../src/gemini-connector.js";

describe("GeminiConnector", () => {
  it("uses the shared default model when none is provided", () => {
    const connector = new GeminiConnector("test-key");
    expect(connector.getModelName()).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("exposes api key, model name, and chat model", () => {
    const connector = new GeminiConnector("test-key", "gemini-2.5-flash");
    expect(connector.getApiKey()).toBe("test-key");
    expect(connector.getModelName()).toBe("gemini-2.5-flash");
    expect(connector.getModel()).toBeDefined();
  });
});

describe("createGeminiChatModel", () => {
  it("defaults temperature to DEFAULT_GEMINI_TEMPERATURE", () => {
    const model = createGeminiChatModel("test-key", "gemini-2.5-flash");
    expect(model.temperature).toBe(DEFAULT_GEMINI_TEMPERATURE);
  });
});

describe("transcribeAudio", () => {
  it("invokes Gemini with inline audio and returns the trimmed transcript", async () => {
    const invoke = vi.spyOn(ChatGoogleGenerativeAI.prototype, "invoke").mockImplementation(
      async function transcribeInvoke(this: ChatGoogleGenerativeAI) {
        expect(this.model).toBe(DEFAULT_AUDIO_MODEL);
        return new AIMessage("  записати на завтра  ") as never;
      },
    );

    const transcript = await transcribeAudio("test-key", {
      mimeType: "audio/ogg",
      data: "YWJj",
    });

    expect(transcript).toBe("записати на завтра");
    expect(invoke).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0]?.[0] as HumanMessage[];
    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        { type: "media", mimeType: "audio/ogg", data: "YWJj" },
      ]),
    );
  });

  it("returns an empty string when the model finds no speech", async () => {
    vi.spyOn(ChatGoogleGenerativeAI.prototype, "invoke").mockResolvedValue(
      new AIMessage("   ") as never,
    );

    await expect(
      transcribeAudio("test-key", { mimeType: "audio/ogg", data: "YWJj" }, "gemini-3.1-flash-lite"),
    ).resolves.toBe("");
  });
});

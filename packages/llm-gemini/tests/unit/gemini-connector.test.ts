import { describe, expect, it } from "vitest";

import {
  createGeminiChatModel,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TEMPERATURE,
  GeminiConnector,
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

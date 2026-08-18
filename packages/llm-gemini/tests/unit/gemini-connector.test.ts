import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createGeminiChatModel,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TEMPERATURE,
  GeminiConnector,
} from "../../src/gemini-connector.js";

const routingSchema = z.object({});

describe("GeminiConnector", () => {
  it("uses the shared default model when none is provided", () => {
    const withStructuredOutput = vi
      .spyOn(ChatGoogleGenerativeAI.prototype, "withStructuredOutput")
      .mockImplementation(function bindDefaultModel(this: ChatGoogleGenerativeAI) {
        expect(this.model).toBe(DEFAULT_GEMINI_MODEL);
        return { invoke: async () => ({}) } as never;
      });

    new GeminiConnector("test-key").bindRoutingTools(routingSchema);

    expect(withStructuredOutput).toHaveBeenCalledTimes(1);
    expect(withStructuredOutput).toHaveBeenCalledWith(routingSchema, { name: "route_request" });
    withStructuredOutput.mockRestore();
  });

  it("uses the provided model name", () => {
    const withStructuredOutput = vi
      .spyOn(ChatGoogleGenerativeAI.prototype, "withStructuredOutput")
      .mockImplementation(function bindNamedModel(this: ChatGoogleGenerativeAI) {
        expect(this.model).toBe("gemini-2.5-flash");
        return { invoke: async () => ({}) } as never;
      });

    new GeminiConnector("test-key", "gemini-2.5-flash").bindRoutingTools(routingSchema);

    expect(withStructuredOutput).toHaveBeenCalledTimes(1);
    withStructuredOutput.mockRestore();
  });
});

describe("createGeminiChatModel", () => {
  it("defaults temperature to DEFAULT_GEMINI_TEMPERATURE", () => {
    const model = createGeminiChatModel("test-key", "gemini-2.5-flash");
    expect(model.temperature).toBe(DEFAULT_GEMINI_TEMPERATURE);
  });
});

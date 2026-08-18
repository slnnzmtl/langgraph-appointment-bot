import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_AUDIO_MODEL, transcribeAudio } from "../../src/gemini-transcribe.js";

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

  it("uses a caller-provided prompt", async () => {
    const invoke = vi.spyOn(ChatGoogleGenerativeAI.prototype, "invoke").mockResolvedValue(
      new AIMessage("ok") as never,
    );

    await transcribeAudio(
      "test-key",
      { mimeType: "audio/ogg", data: "YWJj" },
      DEFAULT_AUDIO_MODEL,
      "Custom prompt",
    );

    const messages = invoke.mock.calls[0]?.[0] as HumanMessage[];
    expect(messages[0]?.content).toEqual(
      expect.arrayContaining([{ type: "text", text: "Custom prompt" }]),
    );
    invoke.mockRestore();
  });
});

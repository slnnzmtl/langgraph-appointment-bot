import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

const requiredEnv = {
  GOOGLE_API_KEY: "test-key",
  ESPOCRM_MCP_URL: "http://espocrm-mcp-server:3000",
  ESPOCRM_API_KEY: "mcp-key",
  ESPOCRM_ASSIGNED_USER_ID: "user-1",
} as const;

const envKeys = [
  ...Object.keys(requiredEnv),
  "GEMINI_CONTEXT_CACHE",
  "GEMINI_MODEL",
  "SUPERVISOR_MODEL",
  "AGENT_MODEL",
  "TELEGRAM_BOT_TOKEN",
  "MESSAGE_HISTORY_MAX_TOKENS",
] as const;

describe("loadConfig", () => {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const applyRequiredEnv = (): void => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      process.env[key] = value;
    }
  };

  it("enables Gemini context cache when GEMINI_CONTEXT_CACHE is unset", () => {
    applyRequiredEnv();
    delete process.env.GEMINI_CONTEXT_CACHE;
    expect(loadConfig().geminiContextCacheEnabled).toBe(true);
  });

  it("disables Gemini context cache when GEMINI_CONTEXT_CACHE is 0 or false", () => {
    applyRequiredEnv();
    process.env.GEMINI_CONTEXT_CACHE = "0";
    expect(loadConfig().geminiContextCacheEnabled).toBe(false);
    process.env.GEMINI_CONTEXT_CACHE = "false";
    expect(loadConfig().geminiContextCacheEnabled).toBe(false);
  });
});

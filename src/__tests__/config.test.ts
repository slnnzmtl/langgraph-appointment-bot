import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { PRODUCTION_CLINIC_ENV_KEYS } from "../shared/clinic-constants.js";

const requiredEnv = {
  GOOGLE_API_KEY: "test-key",
  ESPOCRM_MCP_URL: "http://espocrm-mcp-server:3000",
  ESPOCRM_API_KEY: "mcp-key",
  ESPOCRM_ASSIGNED_USER_ID: "user-1",
} as const;

const clinicEnv = {
  CLINIC_ADDRESS: "prod-address",
  CLINIC_MAPS_URL: "https://maps.example/prod",
  CONSULTATION_SERVICE_ID: "prod-consultation-id",
  CLINIC_NAME_UK: "prod clinic uk",
  CLINIC_NAME_EN: "prod clinic en",
  CLINIC_WELCOME_VENUE_UK: "prod venue",
  CLINIC_DOCTOR_REF_UK: "prod doctor",
} as const;

const envKeys = [
  ...Object.keys(requiredEnv),
  ...PRODUCTION_CLINIC_ENV_KEYS,
  "NODE_ENV",
  "GEMINI_CONTEXT_CACHE",
  "GEMINI_MODEL",
  "SUPERVISOR_MODEL",
  "AGENT_MODEL",
  "TELEGRAM_BOT_TOKEN",
  "WEBHOOK_SECRET",
  "MESSAGE_HISTORY_MAX_TOKENS",
  "CHECKPOINT_DB_PATH",
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

  const applyClinicEnv = (): void => {
    for (const [key, value] of Object.entries(clinicEnv)) {
      process.env[key] = value;
    }
  };

  const clearClinicEnv = (): void => {
    for (const key of PRODUCTION_CLINIC_ENV_KEYS) {
      delete process.env[key];
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

  it("omits webhookSecret when WEBHOOK_SECRET is unset", () => {
    applyRequiredEnv();
    delete process.env.WEBHOOK_SECRET;
    expect(loadConfig().webhookSecret).toBeUndefined();
  });

  it("loads webhookSecret from WEBHOOK_SECRET", () => {
    applyRequiredEnv();
    process.env.WEBHOOK_SECRET = "  reminder-secret  ";
    expect(loadConfig().webhookSecret).toBe("reminder-secret");
  });

  it("allows missing clinic env outside production", () => {
    applyRequiredEnv();
    clearClinicEnv();
    process.env.NODE_ENV = "development";
    expect(() => loadConfig()).not.toThrow();
  });

  it("requires clinic env vars when NODE_ENV is production", () => {
    applyRequiredEnv();
    clearClinicEnv();
    process.env.NODE_ENV = "production";
    expect(() => loadConfig()).toThrow(/CLINIC_ADDRESS/);
  });

  it("loads successfully in production when all clinic env vars are set", () => {
    applyRequiredEnv();
    applyClinicEnv();
    process.env.NODE_ENV = "production";
    expect(() => loadConfig()).not.toThrow();
  });

  it("defaults checkpointDbPath to data/checkpoints.sqlite", () => {
    applyRequiredEnv();
    delete process.env.CHECKPOINT_DB_PATH;
    expect(loadConfig().checkpointDbPath).toBe("data/checkpoints.sqlite");
  });

  it("loads checkpointDbPath from CHECKPOINT_DB_PATH", () => {
    applyRequiredEnv();
    process.env.CHECKPOINT_DB_PATH = "  /tmp/clinic-checkpoints.sqlite  ";
    expect(loadConfig().checkpointDbPath).toBe("/tmp/clinic-checkpoints.sqlite");
  });
});

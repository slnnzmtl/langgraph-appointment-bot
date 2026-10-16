import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { PRODUCTION_CLINIC_ENV_KEYS } from "../shared/clinic-constants.js";

const requiredEnv = {
  GOOGLE_API_KEY: "test-key",
  ESPOCRM_MCP_URL: "http://espocrm-mcp-server:3000",
  ESPOCRM_API_KEY: "mcp-key",
  ESPOCRM_ASSIGNED_USER_ID: "user-1",
} as const;

describe("vitest environment (DDD-267)", () => {
  it("uses NODE_ENV=test so loadConfig does not require production clinic env", () => {
    expect(process.env.NODE_ENV).toBe("test");
    for (const key of Object.keys(requiredEnv)) {
      process.env[key] = requiredEnv[key as keyof typeof requiredEnv];
    }
    for (const name of PRODUCTION_CLINIC_ENV_KEYS) {
      delete process.env[name];
    }
    expect(() => loadConfig()).not.toThrow();
  });
});

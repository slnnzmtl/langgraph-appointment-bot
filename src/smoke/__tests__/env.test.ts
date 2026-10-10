import { afterEach, describe, expect, it } from "vitest";

import { normalizeClinicPhone } from "../../shared/phone.js";
import {
  assertWritesAllowed,
  isIsolatedSmokeTelegramId,
  isLocalMcpUrl,
  isSmokeTesterName,
  DEFAULT_SMOKE_ASSIGNED_USER_ID,
  smokeAssignedUserId,
  uniqueSmokePhone,
  writeGuardPasses,
  writeTelegramId,
} from "../env.js";
import type { SmokeEnv } from "../types.js";

const baseEnv = (overrides: Partial<SmokeEnv> = {}): SmokeEnv => ({
  telegramIdA: writeTelegramId("1"),
  allowWrites: true,
  allowRemoteCrm: false,
  nodeEnv: "development",
  ...overrides,
});

describe("write-smoke isolation", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("generates libphonenumber-valid UA mobiles", () => {
    for (let i = 0; i < 5; i += 1) {
      const phone = uniqueSmokePhone();
      expect(normalizeClinicPhone(phone)).toBe(phone);
    }
  });

  it("defaults smoke writes to the dedicated assigned user", () => {
    const previous = process.env.SMOKE_ASSIGNED_USER_ID;
    delete process.env.SMOKE_ASSIGNED_USER_ID;
    expect(smokeAssignedUserId()).toBe(DEFAULT_SMOKE_ASSIGNED_USER_ID);
    expect(DEFAULT_SMOKE_ASSIGNED_USER_ID).toBe("682dcd0dc0406e042");
    expect(() => smokeAssignedUserId({ requireExplicit: true })).toThrow(/SMOKE_ASSIGNED_USER_ID/);
    process.env.SMOKE_ASSIGNED_USER_ID = "user-override";
    expect(smokeAssignedUserId()).toBe("user-override");
    expect(smokeAssignedUserId({ requireExplicit: true })).toBe("user-override");
    if (previous === undefined) {
      delete process.env.SMOKE_ASSIGNED_USER_ID;
    } else {
      process.env.SMOKE_ASSIGNED_USER_ID = previous;
    }
  });

  it("tags write telegram ids with 9998 prefix", () => {
    const id = writeTelegramId("7");
    expect(isIsolatedSmokeTelegramId(id)).toBe(true);
    expect(id.startsWith("99987")).toBe(true);
  });

  it("does not treat a real telegram id as smoke-isolated", () => {
    expect(isIsolatedSmokeTelegramId("1363967211")).toBe(false);
  });

  it("recognizes smoke tester names only", () => {
    expect(isSmokeTesterName("Smoke", "Tester")).toBe(true);
    expect(isSmokeTesterName("Олена", "Коваль")).toBe(false);
  });

  it("allows loopback and sibling MCP hosts", () => {
    expect(isLocalMcpUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalMcpUrl("http://espocrm-mcp-server:3000")).toBe(true);
    expect(isLocalMcpUrl("https://crm.example.com")).toBe(false);
  });

  it("refuses production, missing flag, and remote CRM", () => {
    expect(() =>
      assertWritesAllowed(baseEnv({ nodeEnv: "production" }), "http://127.0.0.1:3000"),
    ).toThrow(/production/);
    expect(() =>
      assertWritesAllowed(baseEnv({ allowWrites: false }), "http://127.0.0.1:3000"),
    ).toThrow(/SMOKE_ALLOW_WRITES/);
    expect(() =>
      assertWritesAllowed(baseEnv(), "https://espocrm.example.com"),
    ).toThrow(/non-local/);
  });

  it("allows remote CRM only with an explicit opt-in", () => {
    expect(() =>
      assertWritesAllowed(
        baseEnv({ allowRemoteCrm: true }),
        "https://espocrm.example.com",
      ),
    ).not.toThrow();
  });

  it("writeGuardPasses is false for production, remote CRM, and missing flag", () => {
    expect(writeGuardPasses(baseEnv({ nodeEnv: "production" }), "http://127.0.0.1:3000")).toBe(
      false,
    );
    expect(writeGuardPasses(baseEnv({ allowWrites: false }), "http://127.0.0.1:3000")).toBe(
      false,
    );
    expect(writeGuardPasses(baseEnv(), "https://espocrm.example.com")).toBe(false);
    expect(writeGuardPasses(baseEnv(), "http://127.0.0.1:3000")).toBe(true);
    expect(
      writeGuardPasses(baseEnv({ allowRemoteCrm: true }), "https://espocrm.example.com"),
    ).toBe(true);
  });
});

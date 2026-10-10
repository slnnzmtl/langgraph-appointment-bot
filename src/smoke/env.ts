import { randomUUID } from "node:crypto";

import { normalizeClinicPhone } from "../shared/phone.js";
import type { SmokeEnv } from "./types.js";

/**
 * Write-smoke telegram ids always start with this prefix so they cannot be a
 * real Telegram user (those are assigned by Telegram, not 9998…).
 */
export const SMOKE_TELEGRAM_PREFIX = "9998";

export const SMOKE_MEETING_NAME_PREFIX = "[SMOKE]";

/**
 * Dedicated Espo user for smoke writes so meetings are not placed on the
 * production doctor's calendar (ESPOCRM_ASSIGNED_USER_ID).
 */
export const DEFAULT_SMOKE_ASSIGNED_USER_ID = "682dcd0dc0406e042";

export const smokeAssignedUserId = (options?: { requireExplicit?: boolean }): string => {
  const value = process.env.SMOKE_ASSIGNED_USER_ID?.trim();
  if (value) {
    return value;
  }
  if (options?.requireExplicit) {
    throw new Error(
      "Write smoke requires SMOKE_ASSIGNED_USER_ID (dedicated Espo user for smoke meetings)",
    );
  }
  return DEFAULT_SMOKE_ASSIGNED_USER_ID;
};

export const isIsolatedSmokeTelegramId = (telegramId: string): boolean =>
  new RegExp(`^${SMOKE_TELEGRAM_PREFIX}\\d+$`).test(telegramId.trim());

/**
 * Per-scenario write identity. Never derived from SMOKE_KNOWN_TELEGRAM_ID
 * (that may be a real patient).
 */
export const writeTelegramId = (lane: string): string => {
  const laneDigit = lane.replace(/\D/g, "").slice(-1) || "0";
  const entropy = `${Date.now().toString().slice(-7)}${randomUUID().replace(/\D/g, "").slice(0, 2)}`;
  return `${SMOKE_TELEGRAM_PREFIX}${laneDigit}${entropy}`;
};

/** Fresh valid UA mobile; avoids leftover CRM rows that still hold an old smoke phone. */
export const uniqueSmokePhone = (): string => {
  for (let i = 0; i < 40; i += 1) {
    const n = (Number.parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16) + i) % 10_000_000;
    const candidate = normalizeClinicPhone(`+38050${String(n).padStart(7, "0")}`);
    if (candidate) {
      return candidate;
    }
  }
  throw new Error("uniqueSmokePhone: could not generate a valid UA E.164");
};

/** Real-looking names — never "Patient"/"Пацієнт" (booking treats those as dummy). */
export const SMOKE_CONTACT_NAME = {
  firstName: "Smoke",
  lastName: "Tester",
} as const;

export const isSmokeTesterName = (
  firstName: unknown,
  lastName: unknown,
): boolean =>
  typeof firstName === "string"
  && typeof lastName === "string"
  && firstName.trim() === SMOKE_CONTACT_NAME.firstName
  && lastName.trim() === SMOKE_CONTACT_NAME.lastName;

export const loadSmokeEnv = (): SmokeEnv => {
  const knownTelegramId = process.env.SMOKE_KNOWN_TELEGRAM_ID?.trim() || undefined;
  const telegramIdA =
    process.env.SMOKE_TELEGRAM_ID_A?.trim()
    || knownTelegramId
    || writeTelegramId("1");
  return {
    knownTelegramId,
    telegramIdA,
    allowWrites: process.env.SMOKE_ALLOW_WRITES === "1",
    allowRemoteCrm: process.env.SMOKE_ALLOW_REMOTE_CRM === "1",
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
  };
};

export const isLocalMcpUrl = (mcpUrl: string): boolean => {
  try {
    const host = new URL(mcpUrl).hostname.toLowerCase();
    return (
      host === "127.0.0.1"
      || host === "localhost"
      || host === "::1"
      || host === "espocrm-mcp-server"
    );
  } catch {
    return false;
  }
};

/** Non-throwing form of the write guard (used to decide whether probing delete_entity is safe). */
export const writeGuardPasses = (env: SmokeEnv, mcpUrl: string): boolean => {
  if (env.nodeEnv === "production") {
    return false;
  }
  if (!env.allowWrites) {
    return false;
  }
  if (!isLocalMcpUrl(mcpUrl) && !env.allowRemoteCrm) {
    return false;
  }
  return true;
};

export const assertWritesAllowed = (env: SmokeEnv, mcpUrl: string): void => {
  if (env.nodeEnv === "production") {
    throw new Error("Smoke --write refuses to run when NODE_ENV=production");
  }
  if (!env.allowWrites) {
    throw new Error(
      "Smoke --write requires SMOKE_ALLOW_WRITES=1 (refuses live CRM writes otherwise)",
    );
  }
  if (!isLocalMcpUrl(mcpUrl) && !env.allowRemoteCrm) {
    throw new Error(
      `Smoke --write refuses non-local ESPOCRM_MCP_URL (${mcpUrl}). Use the sibling MCP on localhost / espocrm-mcp-server, or set SMOKE_ALLOW_REMOTE_CRM=1 explicitly.`,
    );
  }
  if (env.knownTelegramId && !isIsolatedSmokeTelegramId(env.knownTelegramId)) {
    console.log(
      "✓ Write smoke will not use SMOKE_KNOWN_TELEGRAM_ID (not a 9998… smoke id)",
    );
  }
};

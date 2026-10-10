import { setTimeout as delay } from "node:timers/promises";

import type { McpCallTool } from "../shared/mcp.js";
import type { CleanupRegistryLike } from "./types.js";

const CLEANUP_RETRY_MAX = 4;

const entityIdFromResult = (raw: unknown): string | null => {
  if (typeof raw === "string") {
    try {
      return entityIdFromResult(JSON.parse(raw) as unknown);
    } catch {
      const match = /ID:\s*(\S+)/i.exec(raw);
      return match?.[1] ?? null;
    }
  }
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["id", "meetingId", "contactId", "entityId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const isUnknownToolError = (message: string): boolean =>
  /unknown tool|no such tool/i.test(message);

const isEntityNotFoundError = (message: string): boolean =>
  /not found|404|entity.*not exist|record not found/i.test(message);

const isNoDeleteAccess = (message: string): boolean =>
  /no delete access|delete access|forbidden|403|permission/i.test(message);

const isRateLimitError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /too many requests|rate.?limit|429/i.test(message);
};

const withRateLimitRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < CLEANUP_RETRY_MAX; attempt += 1) {
    try {
      return await run();
    } catch (error: unknown) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === CLEANUP_RETRY_MAX - 1) {
        throw error;
      }
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/**
 * Probe whether MCP exposes delete_entity with usable access.
 * "No delete access" → treat as unsupported so we scrub identity instead of spamming warns.
 */
export const detectDeleteEntitySupport = async (callTool: McpCallTool): Promise<boolean> => {
  try {
    await callTool("delete_entity", {
      entityType: "Meeting",
      entityId: "__smoke_probe_nonexistent__",
    });
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isUnknownToolError(message)) {
      return false;
    }
    if (isNoDeleteAccess(message)) {
      return false;
    }
    if (isEntityNotFoundError(message)) {
      return true;
    }
    // Other validation errors still mean the tool exists and is callable.
    return true;
  }
};

/** cTelegram is a short numeric field in CRM; keep retired ids well under maxLength. */
export const retiredTelegramId = (contactId: string): string =>
  `x${contactId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`;

/** Free phone / telegram so the next smoke run can reuse numbers even without delete ACL. */
const scrubContactIdentity = async (
  callTool: McpCallTool,
  contactId: string,
): Promise<void> => {
  const cTelegram = retiredTelegramId(contactId);
  try {
    await withRateLimitRetry(() =>
      callTool("update_entity", {
        entityType: "Contact",
        entityId: contactId,
        data: { phoneNumber: "", cTelegram },
      }),
    );
    return;
  } catch {
    // Empty phone can fail validation; still unlink telegram so identity lookup misses.
  }
  try {
    await withRateLimitRetry(() =>
      callTool("update_entity", {
        entityType: "Contact",
        entityId: contactId,
        data: { cTelegram },
      }),
    );
  } catch (error: unknown) {
    console.warn(
      `⚠ Cleanup: scrub Contact ${contactId} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
};

export type CleanupRegistry = CleanupRegistryLike & {
  meetingIds: ReadonlySet<string>;
  contactIds: ReadonlySet<string>;
};

export const createCleanupRegistry = (
  callTool: McpCallTool,
  options: { supportsDeleteEntity: boolean } = { supportsDeleteEntity: false },
): CleanupRegistry => {
  const meetings = new Set<string>();
  const contacts = new Set<string>();

  return {
    get meetingIds() {
      return meetings;
    },
    get contactIds() {
      return contacts;
    },
    trackMeeting: (meetingId: string) => {
      const id = meetingId.trim();
      if (id) {
        meetings.add(id);
      }
    },
    trackContact: (contactId: string) => {
      const id = contactId.trim();
      if (id) {
        contacts.add(id);
      }
    },
    run: async () => {
      for (const meetingId of meetings) {
        try {
          await withRateLimitRetry(() =>
            callTool("update_meeting", {
              meetingId,
              status: "Not Held",
            }),
          );
        } catch (error: unknown) {
          console.warn(
            `⚠ Cleanup: update_meeting Not Held failed for ${meetingId}:`,
            error instanceof Error ? error.message : error,
          );
        }
        if (options.supportsDeleteEntity) {
          try {
            await withRateLimitRetry(() =>
              callTool("delete_entity", {
                entityType: "Meeting",
                entityId: meetingId,
              }),
            );
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isNoDeleteAccess(message)) {
              console.warn(`⚠ Cleanup: delete_entity Meeting failed for ${meetingId}:`, message);
            }
          }
        }
      }
      for (const contactId of contacts) {
        let deleted = false;
        if (options.supportsDeleteEntity) {
          try {
            await withRateLimitRetry(() =>
              callTool("delete_entity", {
                entityType: "Contact",
                entityId: contactId,
              }),
            );
            deleted = true;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isNoDeleteAccess(message)) {
              console.warn(`⚠ Cleanup: delete_entity Contact failed for ${contactId}:`, message);
            }
          }
        }
        if (!deleted) {
          // Always scrub so phones/telegram ids are freed for the next run.
          await scrubContactIdentity(callTool, contactId);
        }
      }
      meetings.clear();
      contacts.clear();
    },
  };
};

export const trackIdsFromCallResult = (
  cleanup: CleanupRegistryLike,
  toolName: string,
  result: unknown,
): void => {
  const id = entityIdFromResult(result);
  if (!id) {
    return;
  }
  if (toolName === "create_meeting") {
    cleanup.trackMeeting(id);
  }
  if (toolName === "create_contact") {
    cleanup.trackContact(id);
  }
};

export { entityIdFromResult };

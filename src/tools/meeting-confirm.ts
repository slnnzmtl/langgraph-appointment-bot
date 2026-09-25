import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { getConfig, interrupt } from "@langchain/langgraph";
import { z } from "zod";

import { trackEvent, type BookingAction } from "../analytics/track.js";
import { errorMessage } from "../shared/json-record.js";
import { toToolResult } from "./tool-result.js";

/**
 * HITL resume payloads: Telegram ✅/❌ reply-keyboard taps send `{ confirmed }`, other chat text
 * while the confirm card is pending sends `{ userReply }`. Anything else counts as a decline.
 */
type ConfirmDecision =
  | { kind: "confirmed" }
  | { kind: "chatReply"; userReply: string }
  | { kind: "declined" };

const parseConfirmDecision = (decision: unknown): ConfirmDecision => {
  if (typeof decision !== "object" || decision === null) {
    return { kind: "declined" };
  }
  const { confirmed, userReply } = decision as { confirmed?: unknown; userReply?: unknown };
  if (confirmed === true) {
    return { kind: "confirmed" };
  }
  const reply = typeof userReply === "string" ? userReply.trim() : "";
  return reply.length > 0 ? { kind: "chatReply", userReply: reply } : { kind: "declined" };
};

export type ConfirmDraft = {
  confirmMessage: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
  /** The exact low-level command frozen before the patient confirms. */
  command?: {
    action: BookingAction;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  };
};

export type ConfirmAnalytics = {
  action: BookingAction;
  cancelledMessage?: string;
  contactId?: string;
  serviceId?: string;
  meetingId?: string;
};

const hitlProps = (ctx: ConfirmAnalytics): Record<string, unknown> => ({
  action: ctx.action,
  ...(ctx.contactId ? { contact_id: ctx.contactId } : {}),
  ...(ctx.serviceId ? { service_id: ctx.serviceId } : {}),
  ...(ctx.meetingId ? { meeting_id: ctx.meetingId } : {}),
});

/** Execute MCP write and normalize success/error JSON (no HITL). */
export const runMeetingWrite = async (execute: () => Promise<unknown>): Promise<string> => {
  try {
    return toToolResult(await execute());
  } catch (error) {
    return JSON.stringify({ error: errorMessage(error) });
  }
};

export const CONFIRM_MESSAGE_SCHEMA = z
  .string()
  .min(1)
  .describe(
    "Short Yes/No question in the patient's chat language (e.g. Підтвердити запис?). Caption for the HITL ✅/❌ reply keyboard only — not for chat text. Ignore supervisor prompt language.",
  );

export const CONFIRMATION_GIVEN_SCHEMA = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Set true only on a follow-up call after this tool already paused for Yes/No on this thread and the user then affirmed in chat (awaitingConfirmation) instead of tapping ✅. Ignored unless a matching pending confirm exists for these same arguments. Never set true on the first call. Default false: pauses for Yes/No before writing.",
  );

/** How long a HITL card remains valid for a chat-text `confirmationGiven` re-call. */
const PENDING_CONFIRM_TTL_MS = 15 * 60 * 1000;

export type ConfirmFingerprint = {
  action: BookingAction;
  contactId?: string;
  meetingId?: string;
  serviceId?: string;
  dateStart?: string;
  dateEnd?: string;
};

type PendingConfirm = {
  key: string;
  expiresAt: number;
};

const pendingConfirms = new Map<string, PendingConfirm>();
let configuredPendingConfirmStorePath: string | undefined;

/** Configure the durable sidecar next to the graph checkpoint database. */
export const configurePendingConfirmStore = (checkpointPath: string): void => {
  configuredPendingConfirmStorePath = `${checkpointPath}.pending-confirms.json`;
};

/**
 * Chat-text confirmation is a second graph turn, so its authorization must outlive
 * the Node process. The interrupted keyboard path is already checkpointed by LangGraph;
 * this small sidecar persists only the fingerprint/expiry needed for the chat path.
 */
const pendingConfirmStorePath = (): string | undefined => {
  const checkpointPath = process.env.CHECKPOINT_DB_PATH?.trim();
  if (configuredPendingConfirmStorePath && process.env.NODE_ENV !== "test") {
    return configuredPendingConfirmStorePath;
  }
  if (!checkpointPath || process.env.NODE_ENV === "test") {
    return undefined;
  }
  return `${checkpointPath}.pending-confirms.json`;
};

const loadPendingConfirms = (): void => {
  const path = pendingConfirmStorePath();
  if (!path || pendingConfirms.size > 0 || !existsSync(path)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, PendingConfirm>;
    for (const [threadId, pending] of Object.entries(parsed)) {
      if (
        typeof pending?.key === "string"
        && typeof pending.expiresAt === "number"
        && pending.expiresAt > Date.now()
      ) {
        pendingConfirms.set(threadId, pending);
      }
    }
  } catch {
    // A corrupt sidecar must never block booking; the checkpoint remains authoritative.
  }
};

const persistPendingConfirms = (): void => {
  const path = pendingConfirmStorePath();
  if (!path) {
    return;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(pendingConfirms)), "utf8");
    renameSync(temporary, path);
  } catch {
    // The in-process map remains a safe fallback if the optional sidecar is unavailable.
  }
};

const confirmFingerprintKey = (fp: ConfirmFingerprint): string =>
  JSON.stringify({
    action: fp.action,
    contactId: fp.contactId ?? "",
    meetingId: fp.meetingId ?? "",
    serviceId: fp.serviceId ?? "",
    dateStart: fp.dateStart ?? "",
    dateEnd: fp.dateEnd ?? "",
  });

const threadIdFromRuntime = (config?: { configurable?: { thread_id?: unknown } }): string | undefined => {
  const read = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const fromArg = read(config?.configurable?.thread_id);
  if (fromArg) {
    return fromArg;
  }
  try {
    return read(getConfig()?.configurable?.thread_id);
  } catch {
    return undefined;
  }
};

const rememberPendingConfirm = (threadId: string, fp: ConfirmFingerprint): void => {
  pendingConfirms.set(threadId, {
    key: confirmFingerprintKey(fp),
    expiresAt: Date.now() + PENDING_CONFIRM_TTL_MS,
  });
  persistPendingConfirms();
};

const clearPendingConfirm = (threadId: string): void => {
  pendingConfirms.delete(threadId);
  persistPendingConfirms();
};

/** True when this thread has a non-expired HITL card for these exact write arguments. Consumes it. */
const consumeMatchingPendingConfirm = (threadId: string, fp: ConfirmFingerprint): boolean => {
  loadPendingConfirms();
  const pending = pendingConfirms.get(threadId);
  if (!pending) {
    return false;
  }
  if (pending.expiresAt <= Date.now()) {
    pendingConfirms.delete(threadId);
    persistPendingConfirms();
    return false;
  }
  if (pending.key !== confirmFingerprintKey(fp)) {
    return false;
  }
  pendingConfirms.delete(threadId);
  persistPendingConfirms();
  return true;
};

export const clearPendingConfirmsForTests = (): void => {
  pendingConfirms.clear();
  persistPendingConfirms();
};

/** Shared HITL pause for create / cancel / reschedule — Telegram reuses confirm_booking Yes/No. */
const withUserConfirm = async (
  draft: ConfirmDraft,
  execute: () => Promise<unknown>,
  ctx: ConfirmAnalytics,
  fingerprint: ConfirmFingerprint,
  config?: { configurable?: { thread_id?: unknown } },
): Promise<string> => {
  const threadId = threadIdFromRuntime(config);
  if (threadId) {
    rememberPendingConfirm(threadId, fingerprint);
  }
  trackEvent("booking_confirmation_requested", {
    ...hitlProps(ctx),
    outcome: "awaiting",
  });
  const decision = parseConfirmDecision(interrupt({ type: "confirm_booking", draft }));
  if (decision.kind === "confirmed") {
    if (threadId) {
      clearPendingConfirm(threadId);
    }
    return runMeetingWrite(execute);
  }
  if (decision.kind === "chatReply") {
    trackEvent("booking_awaiting_chat_confirm", {
      ...hitlProps(ctx),
      outcome: "awaiting",
    });
    return JSON.stringify({
      awaitingConfirmation: true,
      userReply: decision.userReply,
      draft,
      hint: "Nothing was written. The user replied in chat instead of tapping ✅/❌. If this reply confirms the action, call this tool again with identical arguments plus confirmationGiven true. The server ignores confirmationGiven unless a HITL card was already shown for these same arguments. Otherwise handle their message normally.",
    });
  }
  if (threadId) {
    clearPendingConfirm(threadId);
  }
  trackEvent("booking_declined", {
    ...hitlProps(ctx),
    outcome: "declined",
  });
  return JSON.stringify({
    cancelled: true,
    message: ctx.cancelledMessage ?? "Cancelled by user.",
  });
};

export const writeAfterChatConfirmOrHitl = async (
  confirmationGiven: boolean | undefined,
  fingerprint: ConfirmFingerprint,
  execute: () => Promise<unknown>,
  draft: ConfirmDraft,
  ctx: ConfirmAnalytics,
  config?: { configurable?: { thread_id?: unknown } },
): Promise<string> => {
  const threadId = threadIdFromRuntime(config);
  if (confirmationGiven && threadId && consumeMatchingPendingConfirm(threadId, fingerprint)) {
    return runMeetingWrite(execute);
  }
  return withUserConfirm(draft, execute, ctx, fingerprint, config);
};

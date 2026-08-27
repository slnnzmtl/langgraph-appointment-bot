import { Client, getDefaultProjectName, isTracingEnabled } from "langsmith";
import { getCurrentRunTree } from "langsmith/traceable";

import { errorMessage, jsonEntityId, jsonErrorMessage, asJsonRecord } from "../shared/json-record.js";
import { getTelegramUserId } from "../tools/telegram-user-context.js";

export const TIER1_EVENTS = [
  "contact_lookup_telegram",
  "contact_lookup_phone",
  "contact_created",
  "contact_telegram_linked",
  "contact_updated",
  "availability_presented",
  "booking_confirmation_requested",
  "booking_declined",
  "booking_awaiting_chat_confirm",
  "meeting_created",
  "meeting_cancelled",
  "meeting_rescheduled",
  "contact_incomplete_blocked",
  "tool_error",
  "reply_menu_filled",
] as const;

export type Tier1EventName = (typeof TIER1_EVENTS)[number];
export type AnalyticsOutcome = "success" | "error" | "not_found" | "declined" | "awaiting";
export type BookingAction = "create" | "cancel" | "reschedule";

export type TrackEventFn = (name: Tier1EventName, props: Record<string, unknown>) => void;

let trackEventSpy: TrackEventFn | null = null;
let sharedClient: Client | undefined;

export const setTrackEventForTests = (fn: TrackEventFn | null): void => {
  trackEventSpy = fn;
};

/** Alias matching the verified plan. */
export const setTrackEventSpy = setTrackEventForTests;

const optionalTelegramUserId = (): string | undefined => {
  try {
    return getTelegramUserId();
  } catch {
    return undefined;
  }
};

/**
 * When tracing is on, hide LLM/tool inputs and outputs unless the operator opted in.
 * Call once at process start, before any LangSmith Client is constructed.
 * Does not hide metadata (telegram_user_id / chat_id stay). Explicit
 * LANGSMITH_HIDE_INPUTS / LANGSMITH_HIDE_OUTPUTS win via ??= .
 */
export const applyTracingPrivacyDefaults = (): void => {
  if (!isTracingEnabled()) {
    return;
  }
  if (process.env.LANGSMITH_TRACE_CONTENT === "true") {
    return;
  }
  process.env.LANGSMITH_HIDE_INPUTS ??= "true";
  process.env.LANGSMITH_HIDE_OUTPUTS ??= "true";
};

const getClient = (): Client => {
  sharedClient ??= new Client({ hideInputs: false, hideOutputs: false });
  return sharedClient;
};

const emitRun = (name: Tier1EventName, props: Record<string, unknown>): void => {
  if (!isTracingEnabled()) {
    return;
  }
  const now = Date.now();
  const parent = getCurrentRunTree(true);
  const outcome = typeof props.outcome === "string" ? props.outcome : "success";
  void getClient()
    .createRun({
      name,
      run_type: "chain",
      inputs: { event: name, ...props },
      outputs: { outcome },
      extra: { metadata: props },
      project_name: getDefaultProjectName(),
      start_time: now,
      end_time: now,
      ...(parent?.id ? { parent_run_id: parent.id } : {}),
    })
    .catch((error: unknown) => {
      console.warn(`trackEvent post failed (${name}): ${errorMessage(error)}`);
    });
};

/** Named booking-funnel event. Never throws. PII-safe props only (ids, counts, dates, field names). */
export const trackEvent: TrackEventFn = (name, props) => {
  try {
    if (process.env.ANALYTICS_DISABLED === "1") {
      return;
    }
    const telegramUserId = optionalTelegramUserId();
    const merged = telegramUserId ? { telegram_user_id: telegramUserId, ...props } : props;
    if (trackEventSpy) {
      trackEventSpy(name, merged);
      return;
    }
    emitRun(name, merged);
  } catch (error: unknown) {
    console.warn(`trackEvent failed (${name}): ${errorMessage(error)}`);
  }
};

const ERROR_MESSAGE_MAX = 200;

export const trackToolError = (tool: string, message: string): void => {
  trackEvent("tool_error", { tool, error_message: message.slice(0, ERROR_MESSAGE_MAX) });
};

/** Track tool_error and return `{ error }` JSON for the tool handler. */
export const toolErrorJson = (tool: string, error: unknown): string => {
  const message = errorMessage(error);
  trackToolError(tool, message);
  return JSON.stringify({ error: message });
};

/**
 * After an MCP write: skip HITL-pending payloads, emit tool_error on `{ error }`, else onSuccess.
 * Returns the original tool JSON unchanged.
 */
export const finishTrackedWrite = (
  tool: string,
  raw: string,
  onSuccess: (entityId?: string) => void,
  options?: { skip?: (record: Record<string, unknown>) => boolean },
): string => {
  const record = asJsonRecord(raw);
  if (record && options?.skip?.(record)) {
    return raw;
  }
  const err = jsonErrorMessage(raw);
  if (err) {
    trackToolError(tool, err);
    return raw;
  }
  onSuccess(jsonEntityId(raw));
  return raw;
};

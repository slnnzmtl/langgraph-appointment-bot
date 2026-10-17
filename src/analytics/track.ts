import { errorMessage, jsonEntityId, jsonErrorMessage, asJsonRecord } from "../shared/json-record.js";
import { getTelegramUserId } from "../tools/telegram-user-context.js";
import { emitLangfuseEvent, flushLangfuseTracing } from "./langfuse.js";

export const TIER1_EVENTS = [
  "contact_lookup_telegram",
  "contact_lookup_phone",
  "contact_created",
  "contact_telegram_linked",
  "contact_updated",
  "contact_write_failed",
  "availability_presented",
  "availability_cache_hit",
  "booking_date_selected",
  "booking_confirmation_requested",
  "booking_declined",
  "booking_awaiting_chat_confirm",
  "booking_note_step",
  "booking_create_blocked_note",
  "booking_checkpoint_migrated",
  "booking_consultation_guard",
  "booking_invariant_violation",
  "booking_runtime_tool",
  "meeting_mutation_outcome",
  "visit_status_response",
  "meeting_created",
  "meeting_cancelled",
  "meeting_rescheduled",
  "contact_incomplete_blocked",
  "tool_error",
  "reply_menu_filled",
  "faq_offer_question_dropped",
  "false_success_claim",
  "supervisor_routing_decision",
  "reminder_sent",
  "reminder_approved",
  "reminder_declined",
] as const;

export type Tier1EventName = (typeof TIER1_EVENTS)[number];
export type AnalyticsOutcome = "success" | "error" | "not_found" | "declined" | "awaiting";
export type BookingAction = "create" | "cancel" | "reschedule";

export type TrackEventFn = (name: Tier1EventName, props: Record<string, unknown>) => void;

let trackEventSpy: TrackEventFn | null = null;

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
    emitLangfuseEvent(name, merged);
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
  options?: {
    skip?: (record: Record<string, unknown>) => boolean;
    requireEntityId?: boolean;
    /** Defaults to jsonEntityId; meeting writes pass committedMeetingEntityId. */
    resolveEntityId?: (raw: string) => string | undefined;
  },
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
  const entityId = (options?.resolveEntityId ?? jsonEntityId)(raw);
  if (options?.requireEntityId && !entityId) {
    trackToolError(tool, "Mutation response did not include an entity id");
    return raw;
  }
  onSuccess(entityId);
  return raw;
};

/**
 * Flush Langfuse (bounded). Never throws past a warn.
 * Safe for SIGINT/SIGTERM and smoke finally — unreachable Langfuse must not hang exit.
 */
export const flushTracing = async (): Promise<void> => {
  await flushLangfuseTracing();
};

export {
  withClinicTurn,
  startLangfuseTracing,
  isLangfuseTracingEnabled,
  createClinicTurnCallbackHandler,
  releaseClinicTurnCallbackHandler,
  type ClinicTurnCallbacks,
} from "./langfuse.js";

/**
 * Provider-neutral Tier 1 property allowlist and Langfuse export masking.
 * No Langfuse / OpenTelemetry imports — safe for unit tests without SDK boot.
 *
 * Object payloads from CallbackHandler (chain/LLM/tool I/O) are deny-by-default:
 * only TIER1_PROP_ALLOWLIST keys are kept. Plain conversation strings (trace I/O)
 * still pass after phone/email/secret regex redaction.
 */

export const TIER1_PROP_ALLOWLIST = [
  "outcome",
  "tool",
  "error_message",
  "contact_id",
  "meeting_id",
  "meeting_ids",
  "meeting_count",
  "hitl",
  "date",
  "date_start",
  "date_end",
  "slot_count",
  "duration_minutes",
  "searched_days",
  "menu",
  "reason",
  "phase",
  "path",
  "intent",
  "mutation",
  "action",
  "service_id",
  "source",
  "kind",
  "rule",
  "agent",
  "has_phone",
  "fields_updated",
  "missing_fields",
  "schemaVersion",
  "choiceId",
  "choiceAccepted",
  "regexStatusSignal",
  "next",
  "draftDiscarded",
  "telegram_user_id",
] as const;

const ALLOWED = new Set<string>(TIER1_PROP_ALLOWLIST);

const SECRET_KEY_RE = /^(GOOGLE_API_KEY|ESPOCRM_API_KEY|Authorization|api[_-]?key|espocrm_api_key|secret[_-]?key|password|token)$/i;

const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  {
    re: /["']?(GOOGLE_API_KEY|ESPOCRM_API_KEY|api[_-]?key|espocrm_api_key)["']?\s*[:=]\s*["']?[^\s"',}]+/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    re: /["']?Authorization["']?\s*[:=]\s*["']?Bearer\s+[^\s"',}]+/gi,
    replacement: "Authorization=[REDACTED]",
  },
  { re: /Bearer\s+[A-Za-z0-9._\-+=/]+/gi, replacement: "Bearer [REDACTED]" },
];

/** E.164-ish phones (Ukraine +380… and general +digits). */
const PHONE_RE = /\+\d{10,15}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export const pickAllowedEventProps = (
  props: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!ALLOWED.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
};

const redactString = (value: string): string => {
  let next = value;
  for (const { re, replacement } of SECRET_PATTERNS) {
    next = next.replace(re, replacement);
  }
  next = next.replace(PHONE_RE, "[REDACTED_PHONE]");
  next = next.replace(EMAIL_RE, "[REDACTED_EMAIL]");
  return next;
};

const maskValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return maskValue(JSON.parse(trimmed) as unknown);
      } catch {
        return redactString(value);
      }
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskValue);
  }
  if (value != null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      if (!ALLOWED.has(key)) {
        // Deny-by-default: unknown object keys (firstName, raw_mcp, checkpoint, …) drop.
        continue;
      }
      out[key] = maskValue(child);
    }
    return out;
  }
  return value;
};

/**
 * LangfuseSpanProcessor `mask` hook: receives stringified JSON of input/output/metadata.
 * Returns masked string (or original non-string data unchanged).
 */
export const maskLangfusePayload = ({ data }: { data: unknown }): unknown => {
  if (typeof data !== "string") {
    return data;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return JSON.stringify(maskValue(parsed));
  } catch {
    return redactString(data);
  }
};

/** Coerce metadata values to strings ≤200 chars for propagateAttributes. */
export const toPropagateMetadata = (
  metadata: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    const str = typeof value === "string" ? value : String(value);
    out[key] = str.length > 200 ? str.slice(0, 200) : str;
  }
  return out;
};

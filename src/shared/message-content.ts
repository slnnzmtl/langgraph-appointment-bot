import type { BaseMessage } from "@langchain/core/messages";

import {
  REPLY_LABELS,
  type ReplyLabelId,
} from "./clinic-constants.js";

type NonTextContentPart = Exclude<
  Extract<BaseMessage["content"], readonly unknown[]>[number],
  string | { type: "text"; text: string }
>;

/**
 * Gemini flash often writes the two-character sequence \\n (sometimes twice-escaped)
 * instead of a real line break. Decode that so Telegram can show paragraphs.
 */
export const unescapeModelLineBreaks = (text: string): string => {
  let result = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (let pass = 0; pass < 2; pass += 1) {
    if (!result.includes("\\n") && !result.includes("\\t")) {
      break;
    }
    result = result.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  }
  return result.replace(/<br\s*\/?>/gi, "\n");
};

/** Concatenate message content without Gemini \\n decoding — safe for tool JSON. */
export const extractRawMessageText = (content: BaseMessage["content"]): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
      .join("\n");
  }

  if (content == null) {
    return "";
  }

  return JSON.stringify(content);
};

export const extractMessageTextContent = (content: BaseMessage["content"]): string =>
  unescapeModelLineBreaks(extractRawMessageText(content));

export const extractNonTextContentParts = (
  content: BaseMessage["content"],
): NonTextContentPart[] => {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter((part): part is NonTextContentPart => {
    if (typeof part === "string") {
      return false;
    }

    return part.type !== "text";
  });
};

const MAX_REPLY_BUTTONS = 6;

/** Trailer from the first `<reply_buttons>` to EOF (model may emit one or several blocks). */
const REPLY_BUTTONS_TRAILER = /(?:\r?\n)*<reply_buttons\b[\s\S]*$/i;

const REPLY_BUTTON_TAG = /<\/?reply_buttons\b[^>]*>/gi;

const YIELD_TO_SUPERVISOR_TAG = /<yield_to_supervisor\s*\/?>/gi;

/** Gemini sometimes writes a function call as XML text instead of `tool_calls`. */
const LEAKED_MODEL_TOOL_CALL =
  /<call:default_api:([A-Za-z0-9_]+)\{([^}]*)\}(?:><\/call:default_api:\1>)?/g;

export type LeakedModelToolCall = {
  name: string;
  args: Record<string, unknown>;
};

const parseLeakedToolArgValue = (raw: string): unknown => {
  const value = raw.trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value.replace(/^["']|["']$/g, "");
};

const parseLeakedToolArgs = (body: string): Record<string, unknown> => {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.startsWith("{") ? trimmed : `{${trimmed}}`);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Gemini emits `{afterDate: 2026-09-29, durationMinutes: 30}` — not JSON.
  }
  const args: Record<string, unknown> = {};
  for (const part of trimmed.split(",")) {
    const colon = part.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const key = part.slice(0, colon).trim();
    if (key.length === 0) {
      continue;
    }
    args[key] = parseLeakedToolArgValue(part.slice(colon + 1));
  }
  return args;
};

export const parseLeakedModelToolCalls = (text: string): LeakedModelToolCall[] => {
  LEAKED_MODEL_TOOL_CALL.lastIndex = 0;
  return [...text.matchAll(LEAKED_MODEL_TOOL_CALL)].map((match) => ({
    name: match[1]!,
    args: parseLeakedToolArgs(match[2] ?? ""),
  }));
};

export const stripLeakedModelToolCalls = (text: string): string => {
  LEAKED_MODEL_TOOL_CALL.lastIndex = 0;
  const stripped = text.replace(LEAKED_MODEL_TOOL_CALL, "");
  if (stripped === text) {
    return text;
  }
  return stripped.replace(/(?:\r?\n){3,}/g, "\n\n").trim();
};

export type ExtractedReplyButtons = {
  text: string;
  buttons: string[];
  /** When true, the next patient message must go through the supervisor. */
  yieldToSupervisor: boolean;
};

const stripYieldToSupervisorTags = (raw: string): { cleaned: string; yieldToSupervisor: boolean } => {
  const yieldToSupervisor = YIELD_TO_SUPERVISOR_TAG.test(raw);
  YIELD_TO_SUPERVISOR_TAG.lastIndex = 0;
  const cleaned = raw
    .replace(YIELD_TO_SUPERVISOR_TAG, "")
    .replace(/(?:\r?\n){3,}/g, "\n\n")
    .trimEnd();
  return { cleaned, yieldToSupervisor };
};

const YES_REPLY = /^(так|yes|да)$/i;
const CONFIRMATION_AFFIRMATION = [
  /^(?:так|yes|да)(?:[\s,]+(?:будь\s+ласка|please|підтверджую|підтвердіть|confirm(?:ed)?|подтверждаю|подтвердите|звісно|sure|of\s+course|конечно))*[\s.!]*$/iu,
  /^(?:підтверджую|підтвердіть|i\s+confirm|confirm(?:ed)?|подтверждаю|подтвердите|звісно|sure|of\s+course|конечно)[\s.!]*$/iu,
  /^👍(?:🏻|🏼|🏽|🏾|🏿)?$/u,
];
const ACTION_CONFIRMATION_AFFIRMATION = {
  create: /^(?:запишіть|записуйте|book(?:\s+(?:it|me))?|запишите)[\s.!]*$/iu,
  reschedule: /^(?:перенесіть|переносьте|reschedule(?:\s+it)?|move\s+it|перенесите)[\s.!]*$/iu,
  cancel: /^(?:скасуйте|скасовуйте|cancel(?:\s+it)?|отмените)[\s.!]*$/iu,
} as const;
const CONFIRMATION_DECLINE = [
  /^(?:ні|no|нет)(?:[\s,]+(?:дякую|thanks|спасибо))?[\s.!]*$/iu,
  /^(?:(?:ні|нет)[\s,]+)?(?:не\s+(?:підтверджую|записуйте|переносьте|скасовуйте|треба|потрібно)|не\s+подтверждаю)[\s.!]*$/iu,
  /^(?:no[\s,]+)?(?:do\s+not|don['’]?t)\s+confirm[\s.!]*$/iu,
  /^(?:do\s+not|don['’]?t)\s+(?:book|reschedule|move|cancel)(?:\s+it)?[\s.!]*$/iu,
  /^не\s+(?:записывайте|переносите|отменяйте)[\s.!]*$/iu,
];
const MENTIONS_CONSULTATION = /консультац|consultation/i;
/** Declines — avoid `\b` before Cyrillic (JS word chars are ASCII-only without `u`). */
const CONSULTATION_NEGATION =
  /(?:(?:^|\s)не\s+(?:хочу|треба|потрібно|бажаю|буду)|без\s+консультац|(?:^|\s)(?:not|don'?t|no)(?:\s|$))/i;
/** Book/browse request naming consultation — not a topic question or decline. */
const CONSULTATION_REQUEST =
  /(?:запиш\w*|записат\w*|хочу|бажаю|потрібн\w*|треба|book|want|need).{0,40}(?:консультац|consultation)|(?:консультац|consultation).{0,40}(?:запиш\w*|записат\w*|будь\s*ласка|please)|^(?:консультація|consultation)$/i;
/** Exact «Так» / Yes / Да (booking-offer keyboard). */
export const isYesReply = (text: string): boolean => YES_REPLY.test(text.trim());

/** Case-fold + collapse whitespace for comparing Telegram chip / menu labels. */
export const normalizeReplyLabel = (text: string): string =>
  text.trim().toLocaleLowerCase().replace(/\s+/g, " ");

/** True when `text` matches any label after {@link normalizeReplyLabel}. */
export const matchesReplyLabel = (
  text: string,
  labels: Iterable<string>,
): boolean => {
  const normalized = normalizeReplyLabel(text);
  if (normalized.length === 0) {
    return false;
  }
  for (const label of labels) {
    if (normalizeReplyLabel(label) === normalized) {
      return true;
    }
  }
  return false;
};

/** Map a patient tap/typed shortcut to a stable {@link ReplyLabelId}. */
export const labelIdFor = (text: string): ReplyLabelId | null => {
  for (const [id, pair] of Object.entries(REPLY_LABELS) as Array<
    [ReplyLabelId, { uk: string; en: string }]
  >) {
    if (matchesReplyLabel(text, [pair.uk, pair.en])) {
      return id;
    }
  }
  return null;
};

/** Explicit free-text affirmation for an already displayed mutation confirmation. */
export const isConfirmationAffirmation = (
  text: string,
  action?: "create" | "reschedule" | "cancel",
): boolean => {
  const trimmed = text.trim();
  return CONFIRMATION_AFFIRMATION.some((pattern) => pattern.test(trimmed))
    || (action != null && ACTION_CONFIRMATION_AFFIRMATION[action].test(trimmed));
};

/** Explicit free-text decline for an already displayed mutation confirmation. */
export const isConfirmationDecline = (text: string): boolean =>
  CONFIRMATION_DECLINE.some((pattern) => pattern.test(text.trim()));

/**
 * True when the patient asks to book «Консультація» (not a topic question or decline).
 * Bare «консультація» counts; «чи є консультація?» and «не хочу консультацію» do not.
 */
export const requestsConsultation = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("?")) {
    return false;
  }
  if (CONSULTATION_NEGATION.test(trimmed)) {
    return false;
  }
  if (!MENTIONS_CONSULTATION.test(trimmed)) {
    return false;
  }
  return CONSULTATION_REQUEST.test(trimmed);
};

/**
 * Stems of CRM service names for loose Ukrainian-declension matching
 * («ботулінотерапія» / «ботулінотерапію» both match the stem «ботулінотерапі»).
 * Short and consultation tokens are skipped — they are not browse signals.
 */
const catalogNameStems = (names: string[]): string[] => {
  const stems = new Set<string>();
  for (const name of names) {
    for (const token of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length < 7 || MENTIONS_CONSULTATION.test(token)) {
        continue;
      }
      stems.add(token.length > 7 ? token.slice(0, token.length - 2) : token);
    }
  }
  return [...stems];
};

/** True when the text names a procedure/family from the CRM catalog. */
export const mentionsCatalogProcedure = (text: string, names: string[]): boolean => {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  return catalogNameStems(names).some((stem) => normalized.includes(stem));
};

/**
 * Defensive strip of accidental yield / `<reply_buttons>` tags so they never reach Telegram.
 * Labels are not the markup channel — the graph writes `lastHandoff.replyButtons`.
 */
export const extractReplyButtons = (raw: string): ExtractedReplyButtons => {
  const { cleaned, yieldToSupervisor } = stripYieldToSupervisorTags(
    stripLeakedModelToolCalls(raw),
  );
  const match = cleaned.match(REPLY_BUTTONS_TRAILER);
  if (!match || match.index === undefined) {
    return { text: cleaned, buttons: [], yieldToSupervisor };
  }

  const before = cleaned.slice(0, match.index).trimEnd();
  const trailer = match[0];
  // When a closing tag exists, labels stop at the last one; any prose after it
  // stays in the visible reply instead of becoming a button label.
  const closeTag = /<\/reply_buttons\b[^>]*>/gi;
  let lastCloseEnd = -1;
  for (const close of trailer.matchAll(closeTag)) {
    lastCloseEnd = (close.index ?? 0) + close[0].length;
  }
  const labelSource = lastCloseEnd >= 0 ? trailer.slice(0, lastCloseEnd) : trailer;
  const after = lastCloseEnd >= 0 ? trailer.slice(lastCloseEnd).trim() : "";

  // Split on tags and newlines so jammed blocks like
  // `A</reply_buttons><reply_buttons>B` become separate labels.
  const seen = new Set<string>();
  const buttons: string[] = [];
  for (const chunk of labelSource.replace(REPLY_BUTTON_TAG, "\n").split(/\r?\n/)) {
    const label = chunk.trim();
    if (!label || label.includes("<") || label.includes(">")) {
      continue;
    }
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    buttons.push(label);
    if (buttons.length >= MAX_REPLY_BUTTONS) {
      break;
    }
  }

  const text = after.length > 0
    ? (before.length > 0 ? `${before}\n\n${after}` : after)
    : before;
  return { text, buttons, yieldToSupervisor };
};

/** Checkpointed `lastHandoff.replyButtons` only — message trailers are never markup. */
export const replyButtonLabels = (stored: unknown): string[] => {
  if (
    Array.isArray(stored)
    && stored.length > 0
    && stored.every((label) => typeof label === "string")
  ) {
    return stored;
  }
  return [];
};

/** Paired or self-closing faq_catalog_action tags (global). */
const FAQ_CATALOG_ACTION_TAG_GLOBAL =
  /<faq_catalog_action\b([^>]*)(?:\/>|>\s*([\s\S]*?)\s*<\/faq_catalog_action\s*>)/gi;

const FAQ_CATALOG_ACTION_ATTR =
  /\baction\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export type FaqCatalogAction = "keep_catalog" | "offer_consultation" | "close_catalog";

const FAQ_CATALOG_ACTIONS = new Set<FaqCatalogAction>([
  "keep_catalog",
  "offer_consultation",
  "close_catalog",
]);

export type ExtractedFaqCatalogAction = {
  /** Visible patient text with the control tag removed. */
  text: string;
  /** Validated action, or null when missing/invalid/conflicting. */
  action: FaqCatalogAction | null;
};

const parseFaqCatalogActionValue = (raw: string | undefined): FaqCatalogAction | null => {
  if (raw == null) {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return FAQ_CATALOG_ACTIONS.has(value as FaqCatalogAction)
    ? (value as FaqCatalogAction)
    : null;
};

/**
 * Extract a validated FAQ catalog control action.
 * Strips every paired and self-closing tag. One valid action is returned;
 * zero, invalid-only, or multiple/conflicting valid actions yield action null.
 */
export const extractFaqCatalogAction = (raw: string): ExtractedFaqCatalogAction => {
  const validActions: FaqCatalogAction[] = [];
  const text = raw
    .replace(FAQ_CATALOG_ACTION_TAG_GLOBAL, (_full, attrs: string, body?: string) => {
      const fromAttr = FAQ_CATALOG_ACTION_ATTR.exec(attrs ?? "");
      const attrValue = fromAttr?.[1] ?? fromAttr?.[2];
      const parsed = parseFaqCatalogActionValue(attrValue)
        ?? parseFaqCatalogActionValue(body);
      if (parsed != null) {
        validActions.push(parsed);
      }
      return "";
    })
    // Scrub any leftover malformed open/close fragments.
    .replace(/<\/?faq_catalog_action\b[^>]*>?/gi, "")
    .replace(/(?:\r?\n){3,}/g, "\n\n")
    .trim();

  // Zero, duplicate, or conflicting valid tags → null (do not pick the first).
  const action = validActions.length === 1 ? validActions[0]! : null;
  return { text, action };
};

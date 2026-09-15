import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

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

/** Yes/no booking offers — never recover catalog bullets from these replies. */
const BOOKING_OFFER_QUESTION =
  /(?:записати\s+вас\s+на\s+консультацію|бажаєте\s+записатися|підібрати\s+(?:вільний\s+)?час|записатися\s+на\s+цю\s+процедуру|book(?:\s+a|\s+you\s+for)?\s+(?:a\s+)?consultation|would\s+you\s+like\s+to\s+book|book\s+this\s+(?:procedure|service))/i;

const lastNonEmptyLine = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? "";

/** True when the reply ends with a consultation / book-this-procedure yes/no question. */
export const isBookingOfferQuestion = (text: string): boolean => {
  const lastLine = lastNonEmptyLine(text);
  return lastLine.includes("?") && BOOKING_OFFER_QUESTION.test(lastLine);
};

const YES_REPLY = /^(так|yes|да)$/i;
const MENTIONS_CONSULTATION = /консультац|consultation/i;
/** Declines — avoid `\b` before Cyrillic (JS word chars are ASCII-only without `u`). */
const CONSULTATION_NEGATION =
  /(?:(?:^|\s)не\s+(?:хочу|треба|потрібно|бажаю|буду)|без\s+консультац|(?:^|\s)(?:not|don'?t|no)(?:\s|$))/i;
/** Book/browse request naming consultation — not a topic question or decline. */
const CONSULTATION_REQUEST =
  /(?:запиш\w*|записат\w*|хочу|бажаю|потрібн\w*|треба|book|want|need).{0,40}(?:консультац|consultation)|(?:консультац|consultation).{0,40}(?:запиш\w*|записат\w*|будь\s*ласка|please)|^(?:консультація|consultation)$/i;
/** Book intent naming a non-consultation procedure/family. */
const OTHER_PROCEDURE_BOOK =
  /(?:запиш\w*|записат\w*|на\s+\S+.{0,40}запиш\w*|book|want).{0,60}/i;

/** Exact «Так» / Yes / Да (booking-offer keyboard). */
export const isYesReply = (text: string): boolean => YES_REPLY.test(text.trim());

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

/** Mentions consultation as a topic without requesting to book it. */
const declinesOrQuestionsConsultation = (text: string): boolean => {
  const trimmed = text.trim();
  if (!MENTIONS_CONSULTATION.test(trimmed)) {
    return false;
  }
  return trimmed.includes("?") || CONSULTATION_NEGATION.test(trimmed);
};

/** Book/browse intent for something other than consultation. */
export const namesOtherProcedureBook = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed || requestsConsultation(trimmed) || isYesReply(trimmed)) {
    return false;
  }
  if (MENTIONS_CONSULTATION.test(trimmed) && !CONSULTATION_NEGATION.test(trimmed)) {
    return false;
  }
  return OTHER_PROCEDURE_BOOK.test(trimmed);
};

/** True when the booking-offer question is specifically for «Консультація». */
export const isConsultationOfferQuestion = (text: string): boolean => {
  if (!isBookingOfferQuestion(text)) {
    return false;
  }
  return MENTIONS_CONSULTATION.test(lastNonEmptyLine(text));
};

/**
 * True when the latest agreement state is to book «Консультація»
 * («Так» after a consultation offer, or an explicit consultation request).
 * Topic questions, declines, and a later other-procedure book clear agreement.
 */
export const patientAgreedToConsultation = (messages: BaseMessage[]): boolean => {
  let awaitingYes = false;
  let agreed = false;
  for (const message of messages) {
    if (message instanceof AIMessage) {
      if (isConsultationOfferQuestion(extractMessageTextContent(message.content))) {
        awaitingYes = true;
      }
      continue;
    }
    if (!(message instanceof HumanMessage)) {
      continue;
    }
    const text = extractMessageTextContent(message.content).trim();
    if (requestsConsultation(text)) {
      agreed = true;
      awaitingYes = false;
      continue;
    }
    if (awaitingYes && isYesReply(text)) {
      agreed = true;
      awaitingYes = false;
      continue;
    }
    if (
      namesOtherProcedureBook(text)
      || declinesOrQuestionsConsultation(text)
      || (awaitingYes && text.length > 0 && !isYesReply(text))
    ) {
      agreed = false;
      awaitingYes = false;
    }
  }
  return agreed;
};

/** Catalog drill-down closing questions (direction / family / zone / brand). */
const CATALOG_CHOICE_QUESTION =
  /(?:який\s+(?:саме\s+)?напрямок|яка\s+(?:саме\s+)?(?:процедура|послуга|зона|ділянка|область|частина)|які\s+(?:саме\s+)?зони|який\s+(?:саме\s+)?варіант|який\s+(?:саме\s+)?препарат|which\s+(?:direction|procedure|service|variant|preparation|zone|area))/i;

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

/** Bullet or numbered CRM-style list item (`• label`, `1. label`, `1) label`). */
const LIST_ITEM_PREFIX = /^(?:[\s•\u2022\-\*]+\s*|\d+[\.\)]\s+)(.+)$/;

const labelBeforeDescription = (raw: string): string => {
  const trimmed = raw.trim();
  const dash = trimmed.search(/\s+[—–]\s+/);
  return (dash >= 0 ? trimmed.slice(0, dash) : trimmed).trim();
};

/**
 * Recover catalog drill-down shortcuts from visible bullet lists.
 * Returns [] unless the reply ends with a catalog-choice question (not a booking offer).
 */
export const catalogChoiceButtonsFromText = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const lastLine = lines.at(-1) ?? "";
  if (!lastLine.includes("?") || isBookingOfferQuestion(trimmed) || !CATALOG_CHOICE_QUESTION.test(lastLine)) {
    return [];
  }

  const seen = new Set<string>();
  const buttons: string[] = [];
  for (const line of lines) {
    if (line === lastLine) {
      continue;
    }
    const match = line.match(LIST_ITEM_PREFIX);
    if (!match) {
      continue;
    }
    const label = labelBeforeDescription(match[1]!);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    buttons.push(label);
    if (buttons.length >= MAX_REPLY_BUTTONS) {
      break;
    }
  }

  return buttons;
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

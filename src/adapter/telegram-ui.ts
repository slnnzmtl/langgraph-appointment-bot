import { unescapeModelLineBreaks } from "../shared/message-content.js";

/** Labels on the HITL Yes/No reply keyboard (sent as normal chat text when tapped). */
export const CONFIRM_YES_LABEL = "✅";
export const CONFIRM_NO_LABEL = "❌";

/** Always appended last on every reply keyboard (back to idle DEFAULT MENU). */
export const MAIN_MENU_LABEL = "Головне меню";

export const DEFAULT_MENU_NO_VISITS = ["Записатись", "Послуги", "Адреса"] as const;
export const DEFAULT_MENU_HAS_VISITS = ["Мій запис", "Послуги", "Адреса"] as const;

/** Visit-change shortcuts after listing upcoming visits (supervisor «Мій запис»). */
export const VISIT_CHANGE_MENU = ["Перенести", "Скасувати", "Ні, дякую"] as const;
export const VISIT_CHANGE_MENU_EN = ["Reschedule", "Cancel", "No, thanks"] as const;

const MAX_REPLY_BUTTONS = 4;

const MOVE_OR_CANCEL_LABEL = new Set<string>([
  VISIT_CHANGE_MENU[0],
  VISIT_CHANGE_MENU[1],
  VISIT_CHANGE_MENU_EN[0],
  VISIT_CHANGE_MENU_EN[1],
]);

/** Ask about this visit — not greeting copy like «записати, перенести чи скасувати візит». */
const ASKS_VISIT_CHANGE =
  /бажаєте перенести (?:або|чи) скасувати|перенести (?:або|чи) скасувати (?:цей|ваш) візит|would you like to (?:reschedule|move) or cancel|(?:reschedule|move) or cancel this visit/i;

/**
 * When the model forgot `<reply_buttons>` (or attached DEFAULT MENU) on a visit-change
 * ask / «Мій запис» listing, inject the visit-change menu.
 */
export const ensureVisitChangeButtons = (
  text: string,
  buttons: string[],
  lastUserText = "",
): string[] => {
  const listed = /запланован|upcoming visit|scheduled visit/i.test(text) && /🗓️|📅/.test(text);
  const myVisit = /^(мій запис|my visit)$/i.test(lastUserText.trim());
  if (
    !(ASKS_VISIT_CHANGE.test(text) || (myVisit && listed))
    || buttons.some((label) => MOVE_OR_CANCEL_LABEL.has(label))
  ) {
    return buttons;
  }
  const english =
    /reschedule|cancel this visit|move or cancel/i.test(text) && !/перенес|скасув/i.test(text);
  return [...(english ? VISIT_CHANGE_MENU_EN : VISIT_CHANGE_MENU)];
};

/** Trailer from the first `<reply_buttons>` to EOF (model may emit one or several blocks). */
const REPLY_BUTTONS_TRAILER = /(?:\r?\n)*<reply_buttons\b[\s\S]*$/i;

const REPLY_BUTTON_TAG = /<\/?reply_buttons\b[^>]*>/gi;

export type KeyboardButton = {
  text: string;
};

export type ReplyKeyboardMarkup = {
  keyboard: KeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
};

export type ExtractedReplyButtons = {
  text: string;
  buttons: string[];
};

export type ConfirmReplyDecision =
  | { kind: "confirmed" }
  | { kind: "declined" }
  | { kind: "chat" };

/** Map HITL reply-keyboard taps (or free text) while a confirm card is pending. */
export const classifyConfirmReply = (text: string): ConfirmReplyDecision => {
  const trimmed = text.trim();
  if (trimmed === CONFIRM_YES_LABEL) {
    return { kind: "confirmed" };
  }
  if (trimmed === CONFIRM_NO_LABEL || trimmed === MAIN_MENU_LABEL) {
    return { kind: "declined" };
  }
  return { kind: "chat" };
};

/** Append «Головне меню» last when missing (adapter-owned; the model need not emit it). */
export const withMainMenu = (labels: string[]): string[] => {
  const next = labels.filter((label) => label !== MAIN_MENU_LABEL);
  next.push(MAIN_MENU_LABEL);
  return next;
};

export const buildConfirmKeyboard = (): ReplyKeyboardMarkup =>
  buildReplyKeyboard(withMainMenu([CONFIRM_YES_LABEL, CONFIRM_NO_LABEL]));

/** Strip a trailing `<reply_buttons>` trailer and return up to 4 unique labels. */
export const extractReplyButtons = (raw: string): ExtractedReplyButtons => {
  const match = raw.match(REPLY_BUTTONS_TRAILER);
  if (!match || match.index === undefined) {
    return { text: raw, buttons: [] };
  }

  const before = raw.slice(0, match.index).trimEnd();
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
  return { text, buttons };
};

/** Rows of up to 2 labels (e.g. 3 → 2+1, 5 → 2+2+1). */
export const buildReplyKeyboard = (labels: string[]): ReplyKeyboardMarkup => {
  const buttons = labels.map((text) => ({ text }));
  const keyboard: KeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  return {
    keyboard,
    resize_keyboard: true,
    one_time_keyboard: true,
  };
};

export const buildDefaultMenuKeyboard = (hasVisit: boolean): ReplyKeyboardMarkup =>
  buildReplyKeyboard(
    withMainMenu([...(hasVisit ? DEFAULT_MENU_HAS_VISITS : DEFAULT_MENU_NO_VISITS)]),
  );

/** Convert common Markdown (bold, links, bullets) to Telegram HTML; escape first. */
export const formatForTelegram = (text: string): string =>
  unescapeModelLineBreaks(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\*|-) /gm, "• ");

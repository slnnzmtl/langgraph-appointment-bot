import {
  MAIN_MENU_LABEL,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import { unescapeModelLineBreaks } from "../shared/message-content.js";

export {
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  MAIN_MENU_LABEL,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";

export { extractReplyButtons, type ExtractedReplyButtons } from "../shared/message-content.js";

/** Labels on the HITL Yes/No reply keyboard (sent as normal chat text when tapped). */
export const CONFIRM_YES_LABEL = "✅";
export const CONFIRM_NO_LABEL = "❌";

export type KeyboardButton = {
  text: string;
};

export type ReplyKeyboardMarkup = {
  keyboard: KeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
};

export type ConfirmReplyDecision =
  | { kind: "confirmed" }
  | { kind: "declined" }
  | { kind: "chat" };

/** Map HITL reply-keyboard taps (or free text) while a confirm card is pending. */
export const classifyConfirmReply = (text: string): ConfirmReplyDecision => {
  const trimmed = text.trim().replace(/\uFE0F|\uFE0E/g, "");
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
  buildReplyKeyboard(withMainMenu([...defaultMenuLabels(hasVisit)]));

/** Convert common Markdown (bold, links, bullets) to Telegram HTML; escape first. */
export const formatForTelegram = (text: string): string =>
  unescapeModelLineBreaks(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\*|-) /gm, "• ");

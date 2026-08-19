export const CONFIRM_YES = "confirm:yes";
export const CONFIRM_NO = "confirm:no";

export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type DecodedCallback =
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "unknown" };

export const decodeCallbackData = (data: string): DecodedCallback => {
  if (data === CONFIRM_YES) {
    return { kind: "confirm", confirmed: true };
  }
  if (data === CONFIRM_NO) {
    return { kind: "confirm", confirmed: false };
  }
  return { kind: "unknown" };
};

export const buildConfirmKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "✅", callback_data: CONFIRM_YES },
      { text: "❌", callback_data: CONFIRM_NO },
    ],
  ],
});

/** Convert common Markdown (bold, links, bullets) to Telegram HTML; escape first. */
export const formatForTelegram = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\*|-) /gm, "• ");

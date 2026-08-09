import type { AvailabilitySlot } from "../tools/availability-slots.js";

export const SLOT_CALLBACK_PREFIX = "slot:";
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
  | { kind: "slot"; dateStart: string; dateEnd: string; label: string }
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "unknown" };

/** Encode slot for Telegram callback_data (64-byte limit). */
export const encodeSlotCallback = (slot: Pick<AvailabilitySlot, "dateStart" | "dateEnd" | "label">): string =>
  `${SLOT_CALLBACK_PREFIX}${slot.dateStart}|${slot.dateEnd}|${slot.label}`;

export const decodeCallbackData = (data: string): DecodedCallback => {
  if (data === CONFIRM_YES) {
    return { kind: "confirm", confirmed: true };
  }
  if (data === CONFIRM_NO) {
    return { kind: "confirm", confirmed: false };
  }
  if (data.startsWith(SLOT_CALLBACK_PREFIX)) {
    const payload = data.slice(SLOT_CALLBACK_PREFIX.length);
    const [dateStart, dateEnd, label] = payload.split("|");
    if (dateStart && dateEnd) {
      return {
        kind: "slot",
        dateStart,
        dateEnd,
        label: label ?? dateStart,
      };
    }
  }
  return { kind: "unknown" };
};

const chunkButtons = (
  buttons: InlineKeyboardButton[],
  perRow: number,
): InlineKeyboardButton[][] => {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
};

export const buildSlotsKeyboard = (slots: AvailabilitySlot[]): InlineKeyboardMarkup => ({
  inline_keyboard: chunkButtons(
    slots.map((slot) => ({
      text: slot.label,
      callback_data: encodeSlotCallback(slot),
    })),
    3,
  ),
});

export const buildConfirmKeyboard = (): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "Yes", callback_data: CONFIRM_YES },
      { text: "No", callback_data: CONFIRM_NO },
    ],
  ],
});

export const slotChoiceHumanText = (dateStart: string, dateEnd: string, label: string): string =>
  `I choose the ${label} slot (${dateStart} – ${dateEnd}).`;

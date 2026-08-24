import {
  extractMessageTextContent,
  extractReplyButtons,
  replyButtonLabels,
} from "../shared/message-content.js";
import { normalizeLocalIsoDatetime } from "../tools/availability-slots.js";
import {
  buildConfirmKeyboard,
  buildReplyKeyboard,
  ensureVisitChangeButtons,
  withMainMenu,
  type ReplyKeyboardMarkup,
} from "./telegram-ui.js";

const CONFIRM_BOOKING_INTERRUPT = "confirm_booking";

export type OutboundReply = {
  text: string;
  reply_markup?: ReplyKeyboardMarkup;
};

export const isConfirmBookingInterrupt = (value: unknown): boolean =>
  !!value
  && typeof value === "object"
  && (value as { type?: string }).type === CONFIRM_BOOKING_INTERRUPT;

const messageText = (content: unknown): string =>
  extractMessageTextContent(content as Parameters<typeof extractMessageTextContent>[0]).trim();

const isRoutingJson = (text: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      && ("next" in parsed || "reply" in parsed);
  } catch {
    return false;
  }
};

const isRoutingLeak = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (isRoutingJson(trimmed)) {
    return true;
  }
  if (/^next\s*=\s*FINISH$/i.test(trimmed)) {
    return true;
  }
  return false;
};

const lastVisibleTurn = (messages: unknown): { ai: string; human: string } => {
  if (!Array.isArray(messages)) {
    return { ai: "", human: "" };
  }

  let lastHumanIndex = -1;
  let human = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as {
      _getType?: () => string;
      constructor?: { name?: string };
      content?: unknown;
    };
    const type = typeof msg._getType === "function" ? msg._getType() : undefined;
    if (type === "human" || msg.constructor?.name === "HumanMessage") {
      lastHumanIndex = i;
      human = messageText(msg.content);
      break;
    }
  }

  let ai = "";
  for (let i = lastHumanIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i] as {
      _getType?: () => string;
      content?: unknown;
      constructor?: { name?: string };
    };
    const type = typeof msg._getType === "function" ? msg._getType() : undefined;
    if (type !== "ai" && msg.constructor?.name !== "AIMessage") {
      continue;
    }
    const text = messageText(msg.content);
    if (isRoutingLeak(text)) {
      continue;
    }
    if (text.length > ai.length) {
      ai = text;
    }
  }

  return { ai, human };
};

type InterruptItem = { value?: unknown };

type ConfirmBookingDraft = {
  name?: string;
  dateStart?: string;
  dateEnd?: string;
  /** Model-written Yes/No prompt in the patient's language (from create_meeting.confirmMessage). */
  confirmMessage?: string;
};

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Parse EspoCRM / draft wall times via shared normalizeLocalIsoDatetime. */
const parseWallClock = (iso: string): WallClock | null => {
  try {
    const normalized = normalizeLocalIsoDatetime(iso);
    const match = normalized.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
    );
    if (!match) {
      return null;
    }
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
    };
  } catch {
    return null;
  }
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatDay = (w: WallClock): string =>
  `${w.day} ${MONTH_SHORT[w.month - 1]} ${w.year}`;

const formatHm = (w: WallClock): string => `${pad2(w.hour)}:${pad2(w.minute)}`;

const formatConfirmSlotRange = (dateStart: string, dateEnd: string): string => {
  const start = parseWallClock(dateStart);
  const end = parseWallClock(dateEnd);
  if (!start || !end) {
    return `${dateStart} – ${dateEnd}`;
  }
  if (
    start.year === end.year
    && start.month === end.month
    && start.day === end.day
  ) {
    return `${formatDay(start)}, ${formatHm(start)}–${formatHm(end)}`;
  }
  return `${formatDay(start)} ${formatHm(start)} – ${formatDay(end)} ${formatHm(end)}`;
};

const formatConfirmBookingDetails = (draft: ConfirmBookingDraft): string => {
  const lines: string[] = [];
  const name = draft.name?.trim();
  if (name) {
    lines.push(name);
  }
  if (draft.dateStart && draft.dateEnd) {
    lines.push(formatConfirmSlotRange(draft.dateStart, draft.dateEnd));
  } else if (draft.dateStart) {
    const start = parseWallClock(draft.dateStart);
    lines.push(start ? `${formatDay(start)}, ${formatHm(start)}` : draft.dateStart);
  }
  return lines.join("\n");
};

/** Title from create_meeting.confirmMessage; details from draft fields. */
const formatConfirmBookingCaption = (draft: ConfirmBookingDraft): string => {
  const title = draft.confirmMessage?.trim() || "Confirm booking?";
  const details = formatConfirmBookingDetails(draft);
  return details.length > 0 ? `${title}\n\n${details}` : title;
};

const getConfirmBookingDraft = (result: Record<string, unknown>): ConfirmBookingDraft | null => {
  const interrupts = result.__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) {
    return null;
  }
  for (const item of interrupts as InterruptItem[]) {
    const value = item?.value;
    if (!isConfirmBookingInterrupt(value)) {
      continue;
    }
    const draft = (value as { draft?: unknown }).draft;
    if (draft && typeof draft === "object") {
      return draft as ConfirmBookingDraft;
    }
    return {};
  }
  return null;
};

export const interpretInvokeResult = (result: unknown): OutboundReply => {
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const messages = record.messages;
  const turn = lastVisibleTurn(messages);
  const rawText = turn.ai || "…";
  const confirmDraft = getConfirmBookingDraft(record);

  if (confirmDraft) {
    return {
      text: formatConfirmBookingCaption(confirmDraft),
      reply_markup: buildConfirmKeyboard(),
    };
  }

  const { text } = extractReplyButtons(rawText);
  const buttons = replyButtonLabels(
    (record.lastHandoff as { replyButtons?: unknown } | undefined)?.replyButtons,
    rawText,
  );
  const visible = text || "…";
  return {
    text: visible,
    reply_markup: buildReplyKeyboard(
      withMainMenu(ensureVisitChangeButtons(visible, buttons, turn.human)),
    ),
  };
};

import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import { extractMessageTextContent } from "../shared/message-content.js";
import {
  normalizeLocalIsoDatetime,
  type AvailabilitySlot,
} from "../tools/availability-slots.js";
import { runWithTelegramUserId } from "../tools/telegram-user-context.js";
import {
  buildConfirmKeyboard,
  buildSlotsKeyboard,
  decodeCallbackData,
  slotChoiceHumanText,
  type InlineKeyboardMarkup,
} from "./telegram-ui.js";
import { loadWelcomeMessage } from "./welcome-message.js";

const PRESENT_SLOTS_TOOL = "present_availability_slots";
/** Temporary: list slots in agent text; re-enable Inline Keyboard later. */
const SLOT_INLINE_KEYBOARD_ENABLED = false;
const GRAPH_RECURSION_LIMIT = 40;

type Graph = ReturnType<ClinicRuntime["getGraph"]>;

export type LaunchClinicBotOptions = {
  token: string;
  runtime: ClinicRuntime;
};

export type ClinicBotHandle = {
  bot: Telegraf;
  stop: (reason?: string) => Promise<void>;
};

type OutboundReply = {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
};

const threadChains = new Map<string, Promise<unknown>>();

/** Serialize graph invokes per Telegram chat (thread_id). */
export const runExclusiveForThread = <T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const run = (threadChains.get(threadId) ?? Promise.resolve()).then(
    () => fn(),
    () => fn(),
  );
  threadChains.set(
    threadId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

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

const lastUserFacingAiText = (messages: unknown): string => {
  if (!Array.isArray(messages)) {
    return "";
  }

  let lastHumanIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { _getType?: () => string; constructor?: { name?: string } };
    const type = typeof msg._getType === "function" ? msg._getType() : undefined;
    if (type === "human" || msg.constructor?.name === "HumanMessage") {
      lastHumanIndex = i;
      break;
    }
  }

  let best = "";
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
    if (text.length > best.length) {
      best = text;
    }
  }

  return best;
};

const lastAiText = (messages: unknown): string => lastUserFacingAiText(messages);

const parseSlotsPayload = (raw: string): AvailabilitySlot[] | null => {
  try {
    const parsed = JSON.parse(raw) as { slots?: unknown };
    if (!Array.isArray(parsed.slots)) {
      return null;
    }
    const slots: AvailabilitySlot[] = [];
    for (const item of parsed.slots) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const s = item as Record<string, unknown>;
      if (
        typeof s.id === "string"
        && typeof s.label === "string"
        && typeof s.dateStart === "string"
        && typeof s.dateEnd === "string"
      ) {
        slots.push({
          id: s.id,
          label: s.label,
          dateStart: s.dateStart,
          dateEnd: s.dateEnd,
        });
      }
    }
    return slots.length > 0 ? slots : null;
  } catch {
    return null;
  }
};

/** Prefer the latest present_availability_slots tool JSON (single slot path). */
export const findPresentedSlots = (messages: unknown): AvailabilitySlot[] | null => {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { name?: string; content?: unknown };
    const isTool = msg instanceof ToolMessage
      || (typeof (msg as { _getType?: () => string })._getType === "function"
        && (msg as { _getType: () => string })._getType() === "tool");
    if (!isTool || msg.name !== PRESENT_SLOTS_TOOL) {
      continue;
    }
    const slots = parseSlotsPayload(messageText(msg.content));
    if (slots) {
      return slots;
    }
  }
  return null;
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
  return details.length > 0 ? `${title}\n${details}` : title;
};

const getConfirmBookingDraft = (result: Record<string, unknown>): ConfirmBookingDraft | null => {
  const interrupts = result.__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) {
    return null;
  }
  for (const item of interrupts as InterruptItem[]) {
    const value = item?.value;
    if (
      !value
      || typeof value !== "object"
      || (value as { type?: string }).type !== "confirm_booking"
    ) {
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
  const text = lastAiText(messages) || "…";
  const confirmDraft = getConfirmBookingDraft(record);

  if (confirmDraft) {
    return {
      text: formatConfirmBookingCaption(confirmDraft),
      reply_markup: buildConfirmKeyboard(),
    };
  }

  if (SLOT_INLINE_KEYBOARD_ENABLED) {
    const slots = findPresentedSlots(messages);
    if (slots) {
      return {
        text: text || "Pick a time below.",
        reply_markup: buildSlotsKeyboard(slots),
      };
    }
  }

  return { text };
};

export const handleGraphTurn = async (
  graph: Graph,
  threadId: string,
  telegramUserId: string,
  input: unknown,
): Promise<OutboundReply> =>
  runWithTelegramUserId(telegramUserId, () =>
    runExclusiveForThread(threadId, async () => {
      const result = await graph.invoke(input as never, {
        configurable: { thread_id: threadId },
        recursionLimit: GRAPH_RECURSION_LIMIT,
      });
      return interpretInvokeResult(result);
    }),
  );

/** Convert common Markdown (bold + bullets) to Telegram HTML; escape first. */
export const formatForTelegram = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^(\*|-) /gm, "• ");

const replyOutbound = async (ctx: Context, outbound: OutboundReply): Promise<void> => {
  await ctx.reply(formatForTelegram(outbound.text), {
    parse_mode: "HTML",
    ...(outbound.reply_markup ? { reply_markup: outbound.reply_markup } : {}),
  });
};

export const launchClinicBot = async (options: LaunchClinicBotOptions): Promise<ClinicBotHandle> => {
  const { token, runtime } = options;
  const graph = runtime.getGraph();
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const { adapters, config } = runtime.getBootstrap();
    const text = await loadWelcomeMessage(adapters.callTool, config.assignedUserId);
    await ctx.reply(formatForTelegram(text), { parse_mode: "HTML" });
  });

  bot.on("text", async (ctx) => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const text = ctx.message.text?.trim();
    if (chatId === undefined || fromId === undefined || !text) {
      return;
    }

    const outbound = await handleGraphTurn(
      graph,
      String(chatId),
      String(fromId),
      { messages: [new HumanMessage(text)] },
    );
    await replyOutbound(ctx, outbound);
  });

  bot.on("callback_query", async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id;
    const fromId = ctx.from?.id;
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (chatId === undefined || fromId === undefined || !data) {
      await ctx.answerCbQuery();
      return;
    }

    const decoded = decodeCallbackData(data);
    await ctx.answerCbQuery();

    let input: unknown;
    if (decoded.kind === "confirm") {
      const msg = ctx.callbackQuery.message;
      if (msg && "text" in msg && msg.text) {
        await ctx.telegram
          .editMessageText(
            msg.chat.id,
            msg.message_id,
            undefined,
            msg.text,
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => undefined);
      }
      input = new Command({ resume: { confirmed: decoded.confirmed } });
    } else if (decoded.kind === "slot") {
      input = {
        messages: [
          new HumanMessage(
            slotChoiceHumanText(decoded.dateStart, decoded.dateEnd, decoded.label),
          ),
        ],
      };
    } else {
      await ctx.reply("Unknown button. Please type your request.");
      return;
    }

    const outbound = await handleGraphTurn(graph, String(chatId), String(fromId), input);
    await replyOutbound(ctx, outbound);
  });

  bot.catch((error: unknown) => {
    console.error("Telegram bot error:", error);
  });

  await bot.launch();
  console.log("Telegram bot polling started.");

  return {
    bot,
    stop: async (reason = "stop") => {
      bot.stop(reason);
    },
  };
};

import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import type { ClinicRuntime } from "../composition/clinic-pack.js";
import type { AvailabilitySlot } from "../tools/availability-slots.js";
import {
  clearTelegramUserId,
  setTelegramUserId,
} from "../tools/telegram-user-context.js";
import {
  buildConfirmKeyboard,
  buildSlotsKeyboard,
  decodeCallbackData,
  slotChoiceHumanText,
  type InlineKeyboardMarkup,
} from "./telegram-ui.js";

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

const messageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
};

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

const getConfirmInterrupt = (result: Record<string, unknown>): boolean => {
  const interrupts = result.__interrupt__;
  if (!Array.isArray(interrupts) || interrupts.length === 0) {
    return false;
  }
  for (const item of interrupts as InterruptItem[]) {
    const value = item?.value;
    if (
      value
      && typeof value === "object"
      && (value as { type?: string }).type === "confirm_booking"
    ) {
      return true;
    }
  }
  return false;
};

export const interpretInvokeResult = (result: unknown): OutboundReply => {
  const record = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const messages = record.messages;
  const text = lastAiText(messages) || "…";

  if (getConfirmInterrupt(record)) {
    return {
      text: /confirm/i.test(text) ? text : `${text}\n\nConfirm booking?`,
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
): Promise<OutboundReply> => {
  setTelegramUserId(telegramUserId);
  try {
    return await runExclusiveForThread(threadId, async () => {
      const result = await graph.invoke(input as never, {
        configurable: { thread_id: threadId },
        recursionLimit: GRAPH_RECURSION_LIMIT,
      });
      return interpretInvokeResult(result);
    });
  } finally {
    clearTelegramUserId();
  }
};

const replyOutbound = async (ctx: Context, outbound: OutboundReply): Promise<void> => {
  await ctx.reply(
    outbound.text,
    outbound.reply_markup ? { reply_markup: outbound.reply_markup } : undefined,
  );
};

export const launchClinicBot = async (options: LaunchClinicBotOptions): Promise<ClinicBotHandle> => {
  const { token, runtime } = options;
  const graph = runtime.getGraph();
  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    await ctx.reply("Clinic appointment bot ready. Ask about hours or book an appointment.");
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

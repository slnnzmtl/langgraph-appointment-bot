import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
  DEFAULT_AUDIO_MODEL,
  transcribeAudio,
} from "@personal-assistant/llm-gemini";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import { runWithTelegramUserId } from "../tools/telegram-user-context.js";
import {
  interpretInvokeResult,
  isConfirmBookingInterrupt,
  type OutboundReply,
} from "./telegram-outbound.js";
import {
  decodeCallbackData,
  formatForTelegram,
  slotChoiceHumanText,
} from "./telegram-ui.js";
import {
  buildStartHistoryText,
  loadWelcomeMessage,
  recordWelcomeInHistory,
  START_FOLLOW_UP,
} from "./welcome-message.js";

const GRAPH_RECURSION_LIMIT = 40;
/** Telegram typing action lasts ~5s; refresh before it expires. */
const TYPING_REFRESH_MS = 4_000;
const VOICE_EMPTY_FALLBACK =
  "Не вдалося розібрати голосове повідомлення. Напишіть текстом, будь ласка.";

type Graph = ReturnType<ClinicRuntime["getGraph"]>;

export type LaunchClinicBotOptions = {
  token: string;
  runtime: ClinicRuntime;
};

export type ClinicBotHandle = {
  bot: Telegraf;
  stop: (reason?: string) => Promise<void>;
};

const threadChains = new Map<string, Promise<unknown>>();

/** Keep Telegram "typing" visible while `work` (graph invoke) is in progress. */
export const withTypingIndicator = async <T>(
  telegram: Pick<Context["telegram"], "sendChatAction">,
  chatId: number,
  work: () => Promise<T>,
): Promise<T> => {
  const sendTyping = () =>
    telegram.sendChatAction(chatId, "typing").catch(() => undefined);

  await sendTyping();
  const interval = setInterval(sendTyping, TYPING_REFRESH_MS);
  try {
    return await work();
  } finally {
    clearInterval(interval);
  }
};

/** Serialize graph invokes per Telegram chat (thread_id). */
const runExclusiveForThread = <T>(
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

type InterruptItem = { value?: unknown };

/** True when the thread is paused on create/cancel/reschedule HITL Yes/No. */
const hasPendingConfirmBooking = async (
  graph: Graph,
  threadId: string,
): Promise<boolean> => {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  const tasks = snapshot.tasks;
  if (!Array.isArray(tasks)) {
    return false;
  }
  for (const task of tasks) {
    const interrupts = (task as { interrupts?: InterruptItem[] }).interrupts;
    if (!Array.isArray(interrupts)) {
      continue;
    }
    for (const item of interrupts) {
      if (isConfirmBookingInterrupt(item?.value)) {
        return true;
      }
    }
  }
  return false;
};

const graphInvokeConfig = (threadId: string, telegramUserId: string) => ({
  configurable: { thread_id: threadId },
  recursionLimit: GRAPH_RECURSION_LIMIT,
  runName: "clinic-turn",
  tags: ["telegram"],
  metadata: {
    telegram_user_id: telegramUserId,
    chat_id: threadId,
    source: "telegram",
  },
});

type GraphInvokeConfig = ReturnType<typeof graphInvokeConfig>;

/** One exclusive graph session per thread. */
const runGraphExclusive = async (
  graph: Graph,
  threadId: string,
  telegramUserId: string,
  run: (config: GraphInvokeConfig) => Promise<unknown>,
): Promise<OutboundReply> =>
  runWithTelegramUserId(telegramUserId, () =>
    runExclusiveForThread(threadId, async () => {
      const result = await run(graphInvokeConfig(threadId, telegramUserId));
      return interpretInvokeResult(result);
    }),
  );

/**
 * Text turn: when a confirm card is pending, resume it with the user's text in a single invoke so
 * the pending tool call keeps its arguments instead of being cancelled.
 */
export const handleGraphTextTurn = async (
  graph: Graph,
  threadId: string,
  telegramUserId: string,
  text: string,
): Promise<OutboundReply> =>
  runGraphExclusive(graph, threadId, telegramUserId, async (config) => {
    if (await hasPendingConfirmBooking(graph, threadId)) {
      return graph.invoke(
        new Command({
          resume: { userReply: text },
          update: { messages: [new HumanMessage(text)] },
        }) as never,
        config,
      );
    }
    return graph.invoke({ messages: [new HumanMessage(text)] } as never, config);
  });

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
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    const { adapters, config } = runtime.getBootstrap();
    const welcome = await loadWelcomeMessage(adapters.callTool, config.assignedUserId);
    await ctx.reply(formatForTelegram(welcome), { parse_mode: "HTML" });
    await ctx.reply(START_FOLLOW_UP);

    const threadId = String(chatId);
    await runExclusiveForThread(threadId, () =>
      recordWelcomeInHistory(graph, threadId, buildStartHistoryText(welcome)),
    );
  });

  bot.on("text", async (ctx) => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const text = ctx.message.text?.trim();
    if (chatId === undefined || fromId === undefined || !text) {
      return;
    }

    const threadId = String(chatId);
    const outbound = await withTypingIndicator(ctx.telegram, chatId, () =>
      handleGraphTextTurn(
        graph,
        threadId,
        String(fromId),
        text,
      ),
    );
    await replyOutbound(ctx, outbound);
  });

  bot.on("voice", async (ctx) => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const voice = ctx.message.voice;
    if (chatId === undefined || fromId === undefined || !voice) {
      return;
    }

    const threadId = String(chatId);
    const { googleApiKey } = runtime.getBootstrap().config;
    const outbound = await withTypingIndicator(ctx.telegram, chatId, async () => {
      let transcript = "";
      try {
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const bytes = Buffer.from(await (await fetch(fileLink.href)).arrayBuffer());
        transcript = await transcribeAudio(
          googleApiKey,
          {
            mimeType: voice.mime_type ?? "audio/ogg",
            data: bytes.toString("base64"),
          },
          process.env.AUDIO_MODEL ?? DEFAULT_AUDIO_MODEL,
        );
      } catch (error: unknown) {
        console.error("Voice transcription failed:", error);
      }
      if (!transcript) {
        return { text: VOICE_EMPTY_FALLBACK };
      }
      return handleGraphTextTurn(graph, threadId, String(fromId), transcript);
    });
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

    const outbound = await withTypingIndicator(ctx.telegram, chatId, () =>
      runGraphExclusive(
        graph,
        String(chatId),
        String(fromId),
        (config) => graph.invoke(input as never, config),
      ),
    );
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

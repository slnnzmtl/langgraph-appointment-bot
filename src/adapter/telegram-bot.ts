import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
  DEFAULT_AUDIO_MODEL,
  transcribeAudio,
} from "@personal-assistant/llm-gemini";
import { Telegraf } from "telegraf";
import type { Context } from "telegraf";

import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import type { McpCallTool } from "../shared/mcp.js";
import { runWithTelegramUserId } from "../tools/telegram-user-context.js";
import {
  REMINDER_CONFIRMED_ACK,
  REMINDER_DECLINED_ACK,
  setReminderConfirmPending,
  takeReminderConfirm,
} from "./reminder-webhook.js";
import {
  interpretInvokeResult,
  isConfirmBookingInterrupt,
  type OutboundReply,
} from "./telegram-outbound.js";
import {
  buildConfirmKeyboard,
  buildDefaultMenuKeyboard,
  classifyConfirmReply,
  formatForTelegram,
} from "./telegram-ui.js";
import {
  buildStartHistoryText,
  hasUpcomingVisit,
  loadWelcomeMessage,
  recordWelcomeInHistory,
  START_FOLLOW_UP,
} from "./welcome-message.js";

const GRAPH_RECURSION_LIMIT = 40;
/** Telegram typing action lasts ~5s; refresh before it expires. */
const TYPING_REFRESH_MS = 4_000;
const VOICE_EMPTY_FALLBACK =
  "Не вдалося розібрати голосове повідомлення. Напишіть текстом, будь ласка.";
export const PRIVATE_CHAT_ONLY =
  "Цей бот працює лише в особистих повідомленнях. Напишіть нам у приватний чат.";
export const RATE_LIMITED_MESSAGE =
  "Забагато повідомлень. Зачекайте хвилину й спробуйте ще раз.";
export const VOICE_TOO_LONG =
  "Голосове повідомлення має бути до 1 хвилини. Напишіть текстом або надішліть коротший запис.";
export const MAX_VOICE_DURATION_SECONDS = 60;
export const USER_MESSAGE_RATE_LIMIT = 20;
export const USER_MESSAGE_RATE_WINDOW_MS = 60_000;

export const isVoiceDurationAllowed = (durationSeconds: number): boolean =>
  durationSeconds <= MAX_VOICE_DURATION_SECONDS;

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
const userMessageTimes = new Map<string, number[]>();

/** True when this user is still under the per-minute message cap. Records the attempt when allowed. */
export const takeUserMessageSlot = (userId: string, now = Date.now()): boolean => {
  const cutoff = now - USER_MESSAGE_RATE_WINDOW_MS;
  const recent = (userMessageTimes.get(userId) ?? []).filter((time) => time > cutoff);
  if (recent.length >= USER_MESSAGE_RATE_LIMIT) {
    userMessageTimes.set(userId, recent);
    return false;
  }
  recent.push(now);
  userMessageTimes.set(userId, recent);
  return true;
};

export const clearUserMessageSlotsForTests = (): void => {
  userMessageTimes.clear();
};

export type DetachedWorkRunner = {
  runDetached: (work: () => Promise<void>) => void;
  waitInflight: () => Promise<void>;
};

/**
 * Run handler bodies off Telegraf's poll loop so getUpdates is not blocked on graph/LLM.
 * Errors are logged here because Telegraf never sees the rejected promise.
 */
export const createDetachedWorkRunner = (): DetachedWorkRunner => {
  const inflight = new Set<Promise<void>>();

  const runDetached = (work: () => Promise<void>): void => {
    const done: Promise<void> = work().then(
      () => undefined,
      (error: unknown) => {
        console.error("Telegram bot error:", error);
      },
    );
    inflight.add(done);
    void done.finally(() => {
      inflight.delete(done);
    });
  };

  return {
    runDetached,
    waitInflight: async () => {
      await Promise.all(inflight);
    },
  };
};

/** Telegraf middleware that returns immediately while `handler` runs in the background. */
export const wrapTelegramHandler = <C>(
  runDetached: (work: () => Promise<void>) => void,
  handler: (ctx: C) => Promise<void>,
): ((ctx: C) => void) =>
  (ctx) => {
    runDetached(() => handler(ctx));
  };

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
 * Text turn: when a confirm card is pending, resume HITL — ✅/❌ reply-keyboard taps map to
 * `{ confirmed }`, any other text goes through as `{ userReply }` so the specialist can re-call.
 */
export const handleGraphTextTurn = async (
  graph: Graph,
  threadId: string,
  telegramUserId: string,
  text: string,
): Promise<OutboundReply> =>
  runGraphExclusive(graph, threadId, telegramUserId, async (config) => {
    if (await hasPendingConfirmBooking(graph, threadId)) {
      const decision = classifyConfirmReply(text);
      if (decision.kind === "confirmed") {
        return graph.invoke(new Command({ resume: { confirmed: true } }) as never, config);
      }
      if (decision.kind === "declined") {
        return graph.invoke(new Command({ resume: { confirmed: false } }) as never, config);
      }
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

/** True when the update should be ignored (not a private chat). Replies with a short notice. */
export const rejectNonPrivateTelegramChat = async (ctx: Context): Promise<boolean> => {
  if (ctx.chat?.type === "private") {
    return false;
  }
  if (ctx.chat) {
    await ctx.reply(PRIVATE_CHAT_ONLY);
  }
  return true;
};

const rejectIfRateLimited = async (
  ctx: Context,
  userId: string | number | undefined,
): Promise<boolean> => {
  if (userId === undefined || takeUserMessageSlot(String(userId))) {
    return false;
  }
  await ctx.reply(RATE_LIMITED_MESSAGE);
  return true;
};

export const launchClinicBot = async (options: LaunchClinicBotOptions): Promise<ClinicBotHandle> => {
  const { token, runtime } = options;
  const graph = runtime.getGraph();
  const bot = new Telegraf(token);
  const { runDetached, waitInflight } = createDetachedWorkRunner();
  const detach = <C>(handler: (ctx: C) => Promise<void>) =>
    wrapTelegramHandler(runDetached, handler);

  bot.start(detach(async (ctx) => {
    if (await rejectNonPrivateTelegramChat(ctx)) {
      return;
    }
    if (await rejectIfRateLimited(ctx, ctx.from?.id)) {
      return;
    }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      return;
    }

    const { adapters, config } = runtime.getBootstrap();
    const fromId = ctx.from?.id;
    const [hasVisit, welcome] = await Promise.all([
      fromId === undefined
        ? Promise.resolve(false)
        : runWithTelegramUserId(String(fromId), () => hasUpcomingVisit(adapters.callTool)),
      loadWelcomeMessage(adapters.callTool, config.assignedUserId),
    ]);
    const reply_markup = buildDefaultMenuKeyboard(hasVisit);
    await ctx.reply(formatForTelegram(welcome), { parse_mode: "HTML", reply_markup });
    await ctx.reply(START_FOLLOW_UP, { reply_markup });

    const threadId = String(chatId);
    await runExclusiveForThread(threadId, () =>
      recordWelcomeInHistory(graph, threadId, buildStartHistoryText(welcome)),
    );
  }));

  bot.on("text", detach(async (ctx) => {
    if (await rejectNonPrivateTelegramChat(ctx)) {
      return;
    }
    if (await rejectIfRateLimited(ctx, ctx.from?.id)) {
      return;
    }
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const text = ctx.message.text?.trim();
    if (chatId === undefined || fromId === undefined || !text) {
      return;
    }

    const telegramUserId = String(fromId);
    const reminderDecision = takeReminderConfirm(telegramUserId, text);
    if (reminderDecision) {
      const { adapters } = runtime.getBootstrap();
      const callTool = adapters.callTool as McpCallTool;
      try {
        for (const meetingId of reminderDecision.meetingIds) {
          await callTool("update_meeting", {
            meetingId,
            status: reminderDecision.status,
          });
        }
      } catch (error: unknown) {
        console.error("Reminder confirm CRM update failed:", error);
        setReminderConfirmPending(telegramUserId, reminderDecision.meetingIds);
        const detail = error instanceof Error ? error.message : "";
        const outsideHours = /outside working hours/i.test(detail);
        await ctx.reply(
          formatForTelegram(
            outsideHours
              ? "Не вдалося оновити візит: у CRM час поза робочим графіком. Адміністратор має дозволити зміну статусу або перенести візит у робочі години."
              : "Вибачте, не вдалося оновити візит. Спробуйте ще раз.",
          ),
          {
            parse_mode: "HTML",
            reply_markup: buildConfirmKeyboard(),
          },
        );
        return;
      }
      const confirmed = reminderDecision.status === "Confirmed";
      await ctx.reply(
        formatForTelegram(confirmed ? REMINDER_CONFIRMED_ACK : REMINDER_DECLINED_ACK),
        {
          parse_mode: "HTML",
          reply_markup: buildDefaultMenuKeyboard(confirmed),
        },
      );
      return;
    }

    const threadId = String(chatId);
    const outbound = await withTypingIndicator(ctx.telegram, chatId, () =>
      handleGraphTextTurn(
        graph,
        threadId,
        telegramUserId,
        text,
      ),
    );
    await replyOutbound(ctx, outbound);
  }));

  bot.on("voice", detach(async (ctx) => {
    if (await rejectNonPrivateTelegramChat(ctx)) {
      return;
    }
    if (await rejectIfRateLimited(ctx, ctx.from?.id)) {
      return;
    }
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    const voice = ctx.message.voice;
    if (chatId === undefined || fromId === undefined || !voice) {
      return;
    }

    const threadId = String(chatId);
    const { googleApiKey } = runtime.getBootstrap().config;
    const outbound = await withTypingIndicator(ctx.telegram, chatId, async () => {
      if (!isVoiceDurationAllowed(voice.duration)) {
        return { text: VOICE_TOO_LONG };
      }
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
  }));

  bot.catch((error: unknown) => {
    console.error("Telegram bot error:", error);
  });

  // Telegraf `launch()` only settles when polling stops. Resolve once getMe succeeds
  // (onLaunch callback) so callers can start the reminder webhook without waiting forever.
  await new Promise<void>((resolve, reject) => {
    void bot
      .launch({}, () => {
        console.log("Telegram bot polling started.");
        resolve();
      })
      .catch(reject);
  });

  return {
    bot,
    stop: async (reason = "stop") => {
      bot.stop(reason);
      await runtime.shutdownAdapters();
      await waitInflight();
    },
  };
};

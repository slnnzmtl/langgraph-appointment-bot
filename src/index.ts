import "dotenv/config";
import { getDefaultProjectName, isTracingEnabled } from "langsmith";

import { launchReminderWebhook } from "./adapter/reminder-webhook.js";
import { launchClinicBot } from "./adapter/telegram-bot.js";
import { applyTracingPrivacyDefaults } from "./analytics/track.js";
import { loadConfig } from "./config.js";
import { createClinicRuntime } from "./composition/clinic-runtime.js";

/**
 * Entrypoint: boots the clinic LangGraph runtime.
 * When TELEGRAM_BOT_TOKEN is set, starts telegraf long polling.
 * When WEBHOOK_SECRET is also set, listens for tomorrow-reminder POSTs.
 */
const main = async (): Promise<void> => {
  const config = loadConfig();
  applyTracingPrivacyDefaults();
  const tracingOn = isTracingEnabled();
  const chatContent =
    process.env.LANGSMITH_TRACE_CONTENT === "true" ? "included" : "redacted";
  console.log(
    `LangSmith tracing: ${tracingOn ? "on" : "off"} (project: ${getDefaultProjectName()}${tracingOn ? `, chat content: ${chatContent}` : ""})`,
  );

  const runtime = await createClinicRuntime(config);
  const agents = runtime.getBootstrap().agents;

  console.log("Clinic graph runtime ready.");
  console.log(
    "Agents:",
    agents.map((agent) => agent.id).join(", "),
  );

  if (!config.telegramBotToken) {
    console.log(
      "TELEGRAM_BOT_TOKEN not set — runtime only. Set the token and re-run `pnpm dev` to poll Telegram.",
    );
    console.log("Run `pnpm smoke` / `pnpm smoke -- --identity` for checks without Telegram.");
    return;
  }

  const handle = await launchClinicBot({
    token: config.telegramBotToken,
    runtime,
  });

  let webhookClose: (() => Promise<void>) | undefined;
  if (config.webhookSecret) {
    const port = Number(process.env.WEBHOOK_PORT) || 8080;
    const webhook = await launchReminderWebhook({
      bot: handle.bot,
      secret: config.webhookSecret,
      port,
    });
    webhookClose = webhook.close;
  } else {
    console.log(
      "WEBHOOK_SECRET not set — Telegram polling only. Set WEBHOOK_SECRET to enable POST /webhooks/tomorrow-reminder.",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down…`);
    if (webhookClose) {
      await webhookClose();
    }
    await handle.stop(signal);
    await runtime.shutdownAdapters();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

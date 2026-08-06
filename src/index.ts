import "dotenv/config";

import { launchClinicBot } from "./adapter/telegram-bot.js";
import { loadConfig } from "./config.js";
import { createClinicPackRuntime } from "./composition/clinic-pack.js";

/**
 * Entrypoint: boots the supervisor runtime.
 * When TELEGRAM_BOT_TOKEN is set, starts telegraf long polling.
 */
const main = async (): Promise<void> => {
  const config = loadConfig();
  const runtime = await createClinicPackRuntime(config);
  const agents = runtime.getBootstrap().runtimeAgents;

  console.log("Clinic supervisor runtime ready.");
  console.log(
    "Seeded agents:",
    agents.map((agent) => `${agent.id} (${agent.capabilityIds.join(", ")})`).join(", "),
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

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down…`);
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

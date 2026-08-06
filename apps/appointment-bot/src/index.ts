import "dotenv/config";

import { loadConfig } from "./config.js";
import { createClinicPackRuntime } from "./composition/clinic-pack.js";

/**
 * Phase 1 entrypoint: boots the supervisor runtime (no Telegram yet).
 * Use `pnpm smoke` to verify seeding + optional graph invoke.
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
  console.log("Telegram adapter lands in Phase 4. Run `pnpm smoke` for a bootstrap check.");
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

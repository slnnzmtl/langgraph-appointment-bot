#!/usr/bin/env node
/**
 * CLI: pnpm scan:booking-checkpoints [-- --db /path/to/checkpoints.sqlite]
 */
import { scanBookingCheckpoints } from "../graph/booking/booking-checkpoint-scanner.js";

const dbFlag = process.argv.indexOf("--db");
const fromFlag = dbFlag >= 0 ? process.argv[dbFlag + 1] : undefined;
const dbPath =
  (fromFlag != null && fromFlag.trim().length > 0
    ? fromFlag.trim()
    : process.env.CHECKPOINT_DB_PATH?.trim())
  || "./data/checkpoints.sqlite";

const main = async (): Promise<void> => {
  const result = await scanBookingCheckpoints(dbPath);
  process.stdout.write(`${JSON.stringify({
    threads: result.extras.threads,
    pausedHitl: result.extras.pausedHitl,
    counts: result.counts,
    dbPath: result.dbPath,
  }, null, 2)}\n`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

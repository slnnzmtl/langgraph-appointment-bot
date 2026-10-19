/**
 * CLI: dry-run scan of CHECKPOINT_DB_PATH (or --db) for schema-2 cutover metrics.
 * Non-PII tallies only — never prints patient text or phone numbers.
 *
 * Usage:
 *   pnpm scan:booking-checkpoints
 *   pnpm scan:booking-checkpoints -- --db data/checkpoints.sqlite
 */
import { resolve } from "node:path";

import { DEFAULT_CHECKPOINT_DB_PATH } from "../config.js";
import { scanBookingCheckpoints } from "../graph/booking-checkpoint-scanner.js";

const parseDbPath = (argv: string[]): string => {
  const flagIndex = argv.findIndex((arg) => arg === "--db" || arg === "--checkpoint-db");
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return resolve(argv[flagIndex + 1]!);
  }
  const fromEnv = process.env.CHECKPOINT_DB_PATH?.trim();
  return resolve(fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CHECKPOINT_DB_PATH);
};

const main = async (): Promise<void> => {
  const dbPath = parseDbPath(process.argv.slice(2));
  const report = await scanBookingCheckpoints(dbPath);
  const payload = {
    dbPath: report.dbPath,
    threads: report.extras.threads,
    pausedHitl: report.extras.pausedHitl,
    counts: report.counts,
  };
  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }));
  process.exitCode = 1;
});

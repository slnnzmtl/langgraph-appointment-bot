import "dotenv/config";

import { applyTracingPrivacyDefaults } from "./analytics/track.js";
import { loadConfig } from "./config.js";
import { createClinicRuntime } from "./composition/clinic-runtime.js";
import { SmokeAssertError } from "./smoke/assert.js";
import { createCleanupRegistry, detectDeleteEntitySupport } from "./smoke/cleanup.js";
import {
  assertWritesAllowed,
  loadSmokeEnv,
  smokeAssignedUserId,
  writeGuardPasses,
} from "./smoke/env.js";
import { scenariosForTiers } from "./smoke/scenarios/index.js";
import type { ScenarioResult, SmokeTier } from "./smoke/types.js";

type CliFlags = {
  invoke: boolean;
  write: boolean;
  all: boolean;
  identity: boolean;
  only: Set<string>;
};

const parseFlags = (argv: string[]): CliFlags => {
  const only = new Set<string>();
  let invoke = false;
  let write = false;
  let all = false;
  let identity = false;
  for (const arg of argv) {
    if (arg === "--invoke") {
      invoke = true;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--identity") {
      identity = true;
    } else if (arg.startsWith("--only=")) {
      for (const name of arg.slice("--only=".length).split(",")) {
        const trimmed = name.trim();
        if (trimmed) {
          only.add(trimmed);
        }
      }
    }
  }
  if (identity) {
    only.add("identity");
    invoke = true;
  }
  return { invoke, write, all, identity, only };
};

const resolveTiers = (flags: CliFlags): SmokeTier[] => {
  if (flags.all || flags.only.size > 0) {
    return ["deterministic", "invoke", "write"];
  }
  const tiers: SmokeTier[] = ["deterministic"];
  if (flags.invoke || flags.identity) {
    tiers.push("invoke");
  }
  if (flags.write) {
    tiers.push("write");
  }
  return tiers;
};

const pad = (value: string, width: number): string =>
  value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;

const printSummary = (results: ScenarioResult[]): void => {
  console.log("\n=== Smoke summary ===");
  console.log(
    `${pad("scenario", 24)} ${pad("tier", 14)} ${pad("status", 8)} ${pad("turns", 6)} ${pad("ms", 8)} warnings`,
  );
  for (const result of results) {
    console.log(
      `${pad(result.name, 24)} ${pad(result.tier, 14)} ${pad(result.status, 8)} ${pad(String(result.turns), 6)} ${pad(String(result.durationMs), 8)} ${result.warnings.length}${result.error ? ` — ${result.error}` : ""}`,
    );
  }
  const failed = results.filter((result) => result.status === "fail").length;
  const warned = results.filter((result) => result.status === "warn").length;
  const passed = results.filter((result) => result.status === "pass").length;
  const skipped = results.filter((result) => result.status === "skip").length;
  console.log(
    `\npass=${passed} warn=${warned} fail=${failed} skip=${skipped} total=${results.length}`,
  );
};

const main = async (): Promise<void> => {
  const flags = parseFlags(process.argv.slice(2));
  const env = loadSmokeEnv();
  const tiers = resolveTiers(flags);

  const scenarios = scenariosForTiers(
    tiers,
    flags.only.size > 0 ? flags.only : undefined,
  );

  if (scenarios.length === 0) {
    throw new Error("No smoke scenarios matched the selected flags");
  }

  const hasWriteScenarios = scenarios.some((scenario) => scenario.tier === "write");
  const config = {
    ...loadConfig(),
    assignedUserId: smokeAssignedUserId(
      hasWriteScenarios ? { requireExplicit: true } : undefined,
    ),
  };
  console.log(`✓ Smoke assigned user ${config.assignedUserId}`);
  // Probe delete_entity only for write scenarios after the write guard passes.
  // Identity seed may still use writesAllowed when the guard passes without --write.
  const writesAllowed = hasWriteScenarios
    ? (assertWritesAllowed(env, config.espocrmMcpUrl), true)
    : writeGuardPasses(env, config.espocrmMcpUrl);
  if (hasWriteScenarios) {
    console.log(
      "✓ Write smoke isolated: telegram ids 9998…, contacts named Smoke Tester, reminder seeds use [SMOKE] meeting names",
    );
  }
  applyTracingPrivacyDefaults();
  const runtime = await createClinicRuntime(config);
  let supportsDeleteEntity = false;
  if (hasWriteScenarios && writesAllowed) {
    supportsDeleteEntity = await detectDeleteEntitySupport(
      runtime.getBootstrap().adapters.callTool,
    );
    console.log(
      `✓ delete_entity ${supportsDeleteEntity ? "available" : "not available (soft-cancel + scrub contact phone/telegram)"}`,
    );
  } else {
    console.log("✓ delete_entity probe skipped (no write scenarios selected)");
  }

  const cleanup = createCleanupRegistry(runtime.getBootstrap().adapters.callTool, {
    supportsDeleteEntity,
  });

  console.log(
    `Running ${scenarios.length} scenario(s): ${scenarios.map((s) => s.name).join(", ")}`,
  );

  const results: ScenarioResult[] = [];
  let interrupted = false;

  const onSignal = (): void => {
    interrupted = true;
    console.warn("\n⚠ Interrupt — running cleanup…");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    for (const scenario of scenarios) {
      if (interrupted) {
        results.push({
          name: scenario.name,
          tier: scenario.tier,
          status: "skip",
          turns: 0,
          durationMs: 0,
          warnings: [],
          error: "interrupted",
        });
        continue;
      }

      const started = Date.now();
      console.log(`\n--- ${scenario.name} (${scenario.tier}) ---`);
      try {
        const outcome = await scenario.run({
          runtime,
          callTool: runtime.getBootstrap().adapters.callTool,
          cleanup,
          supportsDeleteEntity,
          writesAllowed,
          env,
        });
        const warnings = outcome?.warnings ?? [];
        results.push({
          name: scenario.name,
          tier: scenario.tier,
          status: warnings.length > 0 ? "warn" : "pass",
          turns: outcome?.turns ?? 0,
          durationMs: Date.now() - started,
          warnings,
        });
        console.log(
          `✓ ${scenario.name} ${warnings.length > 0 ? `(${warnings.length} soft warning(s))` : "passed"}`,
        );
      } catch (error: unknown) {
        const message =
          error instanceof SmokeAssertError || error instanceof Error
            ? error.message
            : String(error);
        console.error(`✗ ${scenario.name}:`, message);
        results.push({
          name: scenario.name,
          tier: scenario.tier,
          status: "fail",
          turns: 0,
          durationMs: Date.now() - started,
          warnings: [],
          error: message,
        });
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await cleanup.run();
      console.log("✓ CleanupRegistry completed");
    } catch (error: unknown) {
      console.warn(
        "⚠ CleanupRegistry failed:",
        error instanceof Error ? error.message : error,
      );
    }
    await runtime.shutdownAdapters();
    console.log("✓ shutdownAdapters completed");
  }

  printSummary(results);
  if (results.some((result) => result.status === "fail") || interrupted) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

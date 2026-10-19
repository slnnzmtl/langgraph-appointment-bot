import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyUpgradeForScan,
  emptyBookingCheckpointScanCounts,
  scanBookingCheckpoints,
} from "../booking-checkpoint-scanner.js";
import { BOOKING_SCHEMA_VERSION } from "../booking-draft.js";

const ScanState = Annotation.Root({
  bookingSchemaVersion: Annotation<number | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  bookingDraft: Annotation<Record<string, unknown> | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  pendingInteraction: Annotation<Record<string, unknown> | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

describe("booking checkpoint scanner", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const tempDb = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clinic-scan-"));
    dirs.push(dir);
    return join(dir, "checkpoints.sqlite");
  };

  it("classifies expired HITL ahead of generic upgrade", () => {
    expect(
      classifyUpgradeForScan({
        unsupported: false,
        schemaVersionBefore: 1,
        targetSchemaVersion: 2,
        expiredHitl: true,
        slotRevalidation: true,
        recoveredPartial: false,
        failClosed: false,
      }),
    ).toBe("expired_hitl");
    expect(emptyBookingCheckpointScanCounts().upgrade).toBe(0);
  });

  it("opens SqliteSaver and tallies schema-2 current + paused HITL threads", async () => {
    const dbPath = tempDb();
    const saver = SqliteSaver.fromConnString(dbPath);
    const graph = new StateGraph(ScanState)
      .addNode("stamp", async (state) => state)
      .addEdge(START, "stamp")
      .addEdge("stamp", END)
      .compile({ checkpointer: saver });

    await graph.invoke(
      {
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "confirming",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: {
            action: "create",
            payload: { serviceId: "svc-1", contactId: "c-1" },
          },
          replacement: null,
          slotProvenance: "availability_tool",
          slotEvidence: { snapshotId: "snap-1", serviceId: "svc-1" },
        },
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [],
        },
      },
      { configurable: { thread_id: "hitl-thread" } },
    );

    await graph.invoke(
      {
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "service",
          serviceAcceptance: null,
          selectedDate: null,
          selectedSlot: null,
          requestedTime: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: null,
          replacement: null,
          slotProvenance: null,
          slotEvidence: null,
        },
        pendingInteraction: null,
      },
      { configurable: { thread_id: "clean-thread" } },
    );

    const report = await scanBookingCheckpoints(dbPath);
    expect(report.extras.threads).toBe(2);
    expect(report.extras.pausedHitl).toBeGreaterThanOrEqual(1);
    expect(
      report.counts.already_current
      + report.counts.upgrade
      + report.counts.prefetch_required
      + report.counts.slot_revalidation
      + report.counts.expired_hitl
      + report.counts.recovered_partial
      + report.counts.rejected,
    ).toBe(2);
  });
});

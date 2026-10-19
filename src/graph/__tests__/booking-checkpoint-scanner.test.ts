import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { BOOKING_SCHEMA_VERSION, createEmptyBookingDraft } from "../booking-draft.js";
import {
  classifyUpgradeForScan,
  emptyBookingCheckpointScanCounts,
  hasPausedHitl,
  pendingWritesHaveConfirmBooking,
  scanBookingCheckpoints,
  schemaBeforeForScan,
} from "../booking-checkpoint-scanner.js";

describe("schemaBeforeForScan", () => {
  it("treats a missing bookingSchemaVersion as schema 0, never current", () => {
    expect(schemaBeforeForScan(undefined)).toBe(0);
    expect(schemaBeforeForScan(null)).toBe(0);
    expect(schemaBeforeForScan(undefined)).not.toBe(BOOKING_SCHEMA_VERSION);
  });
});

describe("classifyUpgradeForScan", () => {
  it("counts versionless drafts (schemaBefore 0) as upgrade", () => {
    expect(
      classifyUpgradeForScan({
        schemaVersionBefore: schemaBeforeForScan(undefined),
        targetSchemaVersion: BOOKING_SCHEMA_VERSION,
      }),
    ).toBe("upgrade");
  });

  it("prefers slot_revalidation and prefetch_required over already_current", () => {
    expect(
      classifyUpgradeForScan({
        schemaVersionBefore: BOOKING_SCHEMA_VERSION,
        targetSchemaVersion: BOOKING_SCHEMA_VERSION,
        slotRevalidation: true,
      }),
    ).toBe("slot_revalidation");
    expect(
      classifyUpgradeForScan({
        schemaVersionBefore: BOOKING_SCHEMA_VERSION,
        targetSchemaVersion: BOOKING_SCHEMA_VERSION,
        prefetchRequired: true,
      }),
    ).toBe("prefetch_required");
  });

  it("maps fail_closed upgrader outcomes to recovered_partial", () => {
    expect(
      classifyUpgradeForScan({
        schemaVersionBefore: 0,
        targetSchemaVersion: BOOKING_SCHEMA_VERSION,
        failClosed: true,
      }),
    ).toBe("recovered_partial");
  });

  it("exposes empty tallies without PII keys", () => {
    expect(Object.keys(emptyBookingCheckpointScanCounts()).sort()).toEqual([
      "already_current",
      "expired_hitl",
      "prefetch_required",
      "recovered_partial",
      "rejected",
      "slot_revalidation",
      "upgrade",
    ]);
  });
});

describe("hasPausedHitl", () => {
  it("counts mutation_confirm and confirm_booking writes, not bare pendingEffect", () => {
    expect(
      hasPausedHitl({
        pendingInteraction: { kind: "mutation_confirm" },
        draft: null,
      }),
    ).toBe(true);
    expect(
      hasPausedHitl({
        pendingInteraction: null,
        draft: {
          ...createEmptyBookingDraft(),
          pendingDecision: {
            kind: "mutation_confirm",
            action: "create",
            effectId: "eff-1",
          },
        },
      }),
    ).toBe(true);
    expect(
      hasPausedHitl({
        pendingInteraction: null,
        draft: {
          ...createEmptyBookingDraft(),
          pendingEffect: {
            id: "eff-1",
            expectedRevision: 1,
            effect: { kind: "get_working_time" },
            status: "prepared",
          },
        },
        pendingWrites: [["noop", {}]],
      }),
    ).toBe(false);
    expect(pendingWritesHaveConfirmBooking([["__interrupt__", { type: "confirm_booking" }]])).toBe(
      true,
    );
  });
});

describe("scanBookingCheckpoints Sqlite fixtures", () => {
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

  const ScanState = Annotation.Root({
    bookingSchemaVersion: Annotation<number | null>({
      reducer: (_l, r) => r,
      default: () => null,
    }),
    bookingDraft: Annotation<unknown>({
      reducer: (_l, r) => r,
      default: () => null,
    }),
    pendingInteraction: Annotation<unknown>({
      reducer: (_l, r) => r,
      default: () => null,
    }),
    availabilityContext: Annotation<unknown>({
      reducer: (_l, r) => r,
      default: () => null,
    }),
    result: Annotation<string>({
      reducer: (_l, r) => r,
      default: () => "",
    }),
  });

  const withService = () => {
    const draft = createEmptyBookingDraft();
    return {
      ...draft,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: "svc-1", name: "Консультація", source: "catalog" as const },
      },
    };
  };

  const seedGraph = (dbPath: string) => {
    const saver = SqliteSaver.fromConnString(dbPath);
    return new StateGraph(ScanState)
      .addNode("seed", async (state) => ({ result: state.result }))
      .addEdge(START, "seed")
      .addEdge("seed", END)
      .compile({ checkpointer: saver });
  };

  it("classifies representative rows via the real upgrader", async () => {
    const dbPath = tempDb();
    const graph = seedGraph(dbPath);

    await graph.invoke(
      {
        result: "versionless",
        bookingSchemaVersion: 0,
        bookingDraft: withService(),
        availabilityContext: { days: [] },
      },
      { configurable: { thread_id: "t-versionless" } },
    );

    await graph.invoke(
      {
        result: "clean",
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: withService(),
        availabilityContext: { days: [] },
      },
      { configurable: { thread_id: "t-clean" } },
    );

    await graph.invoke(
      {
        result: "slot",
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: {
          ...withService(),
          selectedDate: "2026-10-21",
          selectedSlot: {
            start: "2026-10-21T09:00:00+03:00",
            end: "2026-10-21T09:30:00+03:00",
          },
          slotProvenance: "unverified_legacy",
        },
        availabilityContext: { days: [] },
      },
      { configurable: { thread_id: "t-slot" } },
    );

    await graph.invoke(
      {
        result: "prefetch",
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: withService(),
      },
      { configurable: { thread_id: "t-prefetch" } },
    );

    const confirming = {
      ...withService(),
      phase: "confirming" as const,
      pendingDecision: {
        kind: "mutation_confirm" as const,
        action: "create" as const,
        effectId: "eff-1",
      },
      pendingCommand: {
        action: "create" as const,
        payload: { serviceId: "svc-1", contactId: "c-1" },
      },
    };
    await graph.invoke(
      {
        result: "hitl",
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: confirming,
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [{ id: "confirm", label: "✅" }],
        },
        availabilityContext: { days: [] },
      },
      { configurable: { thread_id: "t-hitl" } },
    );

    await graph.invoke(
      {
        result: "effect",
        bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
        bookingDraft: {
          ...withService(),
          pendingEffect: {
            id: "eff-avail",
            expectedRevision: 1,
            effect: { kind: "get_working_time" },
            status: "prepared",
          },
        },
        availabilityContext: { days: [] },
      },
      { configurable: { thread_id: "t-effect" } },
    );

    // Corrupt accepted service id → real upgrader fail_closed → recovered_partial.
    await graph.invoke(
      {
        result: "fail-closed",
        bookingSchemaVersion: 0,
        bookingDraft: {
          ...createEmptyBookingDraft(),
          serviceAcceptance: {
            status: "accepted" as const,
            service: { id: "   ", name: "Broken", source: "catalog" as const },
          },
        },
      },
      { configurable: { thread_id: "t-fail-closed" } },
    );

    const report = await scanBookingCheckpoints(dbPath);
    expect(report.extras.threads).toBe(7);
    expect(report.extras.pausedHitl).toBe(1);
    expect(report.counts).toEqual({
      already_current: 3, // clean + hitl + bare pendingEffect
      upgrade: 1,
      prefetch_required: 1,
      slot_revalidation: 1,
      expired_hitl: 0,
      recovered_partial: 1,
      rejected: 0,
    });
  });
});

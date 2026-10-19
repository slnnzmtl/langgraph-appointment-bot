import { describe, expect, it } from "vitest";

import { BOOKING_SCHEMA_VERSION } from "../booking-draft.js";
import {
  classifyUpgradeForScan,
  emptyBookingCheckpointScanCounts,
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

  it("counts explicit current schema as already_current", () => {
    expect(
      classifyUpgradeForScan({
        schemaVersionBefore: BOOKING_SCHEMA_VERSION,
        targetSchemaVersion: BOOKING_SCHEMA_VERSION,
      }),
    ).toBe("already_current");
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

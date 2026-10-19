/**
 * Offline dry-run scanner stub (DDD-273). Full implementation is DDD-278A.
 * Counts migration outcomes without PII.
 */

export type BookingCheckpointScanOutcome =
  | "already_current"
  | "upgrade"
  | "prefetch_required"
  | "slot_revalidation"
  | "expired_hitl"
  | "recovered_partial"
  | "rejected";

export type BookingCheckpointScanCounts = Record<BookingCheckpointScanOutcome, number>;

export const emptyBookingCheckpointScanCounts = (): BookingCheckpointScanCounts => ({
  already_current: 0,
  upgrade: 0,
  prefetch_required: 0,
  slot_revalidation: 0,
  expired_hitl: 0,
  recovered_partial: 0,
  rejected: 0,
});

/**
 * Stub: classify a single checkpoint upgrade result into scanner buckets.
 * Does not open the checkpoint DB — DDD-278A wires SqliteSaver iteration.
 */
export const classifyUpgradeForScan = (input: {
  unsupported: boolean;
  schemaVersionBefore: number | null | undefined;
  targetSchemaVersion: number;
  expiredHitl: boolean;
  slotRevalidation: boolean;
  recoveredPartial: boolean;
  failClosed: boolean;
}): BookingCheckpointScanOutcome => {
  if (input.unsupported || input.failClosed) {
    return input.failClosed && !input.unsupported ? "recovered_partial" : "rejected";
  }
  if (
    input.schemaVersionBefore === input.targetSchemaVersion
    || input.schemaVersionBefore == null && false
  ) {
    return "already_current";
  }
  if (input.expiredHitl) {
    return "expired_hitl";
  }
  if (input.slotRevalidation) {
    return "slot_revalidation";
  }
  if (input.recoveredPartial) {
    return "recovered_partial";
  }
  if (
    input.schemaVersionBefore === input.targetSchemaVersion
  ) {
    return "already_current";
  }
  return "upgrade";
};

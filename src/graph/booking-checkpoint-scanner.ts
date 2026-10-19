/**
 * Offline dry-run checkpoint scanner (atomic cutover).
 * Opens SqliteSaver, iterates threads, classifies non-PII migration buckets.
 *
 * Critical: a missing bookingSchemaVersion is schema 0 (state default), never
 * BOOKING_SCHEMA_VERSION — versionless drafts count as `upgrade`.
 */
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import {
  BOOKING_SCHEMA_VERSION,
  type BookingDraft,
} from "./booking-draft.js";

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

export type BookingCheckpointScanExtras = {
  pausedHitl: number;
  threads: number;
};

export type BookingCheckpointScanReport = {
  counts: BookingCheckpointScanCounts;
  extras: BookingCheckpointScanExtras;
  dbPath: string;
};

type ChannelValues = {
  bookingSchemaVersion?: number | null;
  bookingDraft?: BookingDraft | null;
  pendingInteraction?: { kind?: string } | null;
  availabilityContext?: unknown;
};

/**
 * Resolve schemaBefore for scanning. Missing/nullish channel → 0 (state default).
 * Never fall back to BOOKING_SCHEMA_VERSION when a draft exists.
 */
export const schemaBeforeForScan = (
  bookingSchemaVersion: number | null | undefined,
): number => (bookingSchemaVersion == null ? 0 : bookingSchemaVersion);

export const classifyUpgradeForScan = (input: {
  unsupported?: boolean;
  schemaVersionBefore: number;
  targetSchemaVersion: number;
  expiredHitl?: boolean;
  slotRevalidation?: boolean;
  recoveredPartial?: boolean;
  failClosed?: boolean;
  prefetchRequired?: boolean;
}): BookingCheckpointScanOutcome => {
  if (input.unsupported || input.failClosed) {
    return input.failClosed && !input.unsupported ? "recovered_partial" : "rejected";
  }
  if (input.schemaVersionBefore === input.targetSchemaVersion) {
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
  if (input.prefetchRequired) {
    return "prefetch_required";
  }
  return "upgrade";
};

const listThreadIds = (saver: SqliteSaver): string[] => {
  const rows = saver.db
    .prepare("SELECT DISTINCT thread_id AS thread_id FROM checkpoints")
    .all() as Array<{ thread_id: string }>;
  return rows.map((row) => row.thread_id).filter((id) => typeof id === "string" && id.length > 0);
};

const channelValuesFromTuple = (tuple: {
  checkpoint?: { channel_values?: Record<string, unknown> };
}): ChannelValues => {
  const values = tuple.checkpoint?.channel_values ?? {};
  const schemaRaw = values.bookingSchemaVersion;
  const result: ChannelValues = {
    bookingDraft: (values.bookingDraft as BookingDraft | null | undefined) ?? null,
    pendingInteraction:
      (values.pendingInteraction as { kind?: string } | null | undefined) ?? null,
    availabilityContext: values.availabilityContext,
  };
  if (typeof schemaRaw === "number" || schemaRaw === null) {
    result.bookingSchemaVersion = schemaRaw;
  }
  return result;
};

const hasPausedHitl = (input: {
  pendingInteraction: { kind?: string } | null | undefined;
  draft: BookingDraft | null | undefined;
  pendingWrites?: unknown;
}): boolean => {
  if (input.pendingInteraction?.kind === "mutation_confirm") {
    return true;
  }
  if (
    input.draft?.pendingCommand != null
    || input.draft?.pendingDecision?.kind === "mutation_confirm"
    || input.draft?.pendingEffect != null
  ) {
    return true;
  }
  if (Array.isArray(input.pendingWrites) && input.pendingWrites.length > 0) {
    return true;
  }
  return false;
};

/** Dry-run scan of a checkpoint sqlite file. Does not write upgrades. */
export const scanBookingCheckpoints = async (
  dbPath: string,
): Promise<BookingCheckpointScanReport> => {
  const saver = SqliteSaver.fromConnString(dbPath);
  const counts = emptyBookingCheckpointScanCounts();
  const extras: BookingCheckpointScanExtras = {
    pausedHitl: 0,
    threads: 0,
  };

  const threadIds = listThreadIds(saver);
  extras.threads = threadIds.length;

  for (const threadId of threadIds) {
    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId },
    });
    if (tuple == null) {
      continue;
    }
    const channels = channelValuesFromTuple(tuple);
    const draft = channels.bookingDraft ?? null;
    const schemaBefore = schemaBeforeForScan(channels.bookingSchemaVersion);

    const paused = hasPausedHitl({
      pendingInteraction: channels.pendingInteraction,
      draft,
      pendingWrites: tuple.pendingWrites,
    });
    if (paused) {
      extras.pausedHitl += 1;
    }

    const expiredHitl =
      paused
      && (
        draft?.pendingCommand == null
        || draft.pendingDecision?.kind !== "mutation_confirm"
      )
      && schemaBefore < BOOKING_SCHEMA_VERSION;
    const slotRevalidation =
      draft?.selectedSlot != null
      && (
        draft.slotProvenance == null
        || draft.slotProvenance === "unverified_legacy"
        || draft.slotEvidence == null
      );
    const prefetchRequired =
      draft != null && channels.availabilityContext == null;

    const outcome = classifyUpgradeForScan({
      schemaVersionBefore: schemaBefore,
      targetSchemaVersion: BOOKING_SCHEMA_VERSION,
      expiredHitl,
      slotRevalidation: slotRevalidation && !expiredHitl,
      prefetchRequired: prefetchRequired && schemaBefore < BOOKING_SCHEMA_VERSION && !expiredHitl,
    });
    counts[outcome] += 1;
  }

  return { counts, extras, dbPath };
};

/**
 * Offline dry-run checkpoint scanner (atomic cutover).
 * Opens SqliteSaver, iterates threads, classifies non-PII migration buckets.
 *
 * Critical: a missing bookingSchemaVersion is schema 0 (state default), never
 * BOOKING_SCHEMA_VERSION — versionless drafts count as `upgrade`.
 * Classification calls the real upgrader so recovered_partial / rejected match
 * production upgrade outcomes.
 */
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import {
  BOOKING_SCHEMA_VERSION,
  type BookingDraft,
} from "./booking-draft.js";
import { upgradeBookingDraftCheckpoint } from "./booking-checkpoint-upgrade.js";

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
  if (input.unsupported) {
    return "rejected";
  }
  if (input.failClosed || input.recoveredPartial) {
    return "recovered_partial";
  }
  if (input.expiredHitl) {
    return "expired_hitl";
  }
  // Invalid slot / missing prefetch beat already_current even on current schema.
  if (input.slotRevalidation) {
    return "slot_revalidation";
  }
  if (input.prefetchRequired) {
    return "prefetch_required";
  }
  if (input.schemaVersionBefore === input.targetSchemaVersion) {
    return "already_current";
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

/** True when pendingWrites encode a confirm_booking interrupt (not arbitrary writes). */
export const pendingWritesHaveConfirmBooking = (pendingWrites: unknown): boolean => {
  if (!Array.isArray(pendingWrites)) {
    return false;
  }
  for (const entry of pendingWrites) {
    const serialized = JSON.stringify(entry);
    if (serialized.includes("confirm_booking")) {
      return true;
    }
  }
  return false;
};

/**
 * Confirm / frozen-write HITL only — not every pendingEffect and not any
 * non-empty pendingWrites bag.
 */
export const hasPausedHitl = (input: {
  pendingInteraction: { kind?: string } | null | undefined;
  draft: BookingDraft | null | undefined;
  pendingWrites?: unknown;
}): boolean => {
  if (input.pendingInteraction?.kind === "mutation_confirm") {
    return true;
  }
  if (input.draft?.pendingDecision?.kind === "mutation_confirm") {
    return true;
  }
  const command = input.draft?.pendingCommand;
  if (
    command != null
    && (command.action === "create"
      || command.action === "reschedule"
      || command.action === "cancel")
  ) {
    return true;
  }
  return pendingWritesHaveConfirmBooking(input.pendingWrites);
};

const needsSlotRevalidation = (draft: BookingDraft | null): boolean => {
  if (draft?.selectedSlot == null) {
    return false;
  }
  return draft.slotProvenance == null
    || draft.slotProvenance === "unverified_legacy"
    || draft.slotEvidence == null
    || draft.slotEvidence.snapshotId.trim().length === 0;
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

    // Real upgrader — recovered_partial / rejected match production outcomes.
    const upgrade = upgradeBookingDraftCheckpoint({
      ...(channels.bookingSchemaVersion !== undefined
        ? { bookingSchemaVersion: channels.bookingSchemaVersion }
        : {}),
      bookingDraft: draft,
    });
    const failClosed = upgrade.telemetry?.outcome === "fail_closed";
    const unsupported = upgrade.unsupported === true;

    const expiredHitl =
      paused
      && schemaBefore < BOOKING_SCHEMA_VERSION
      && (
        draft?.pendingDecision?.kind !== "mutation_confirm"
        && draft?.pendingCommand == null
      );

    const slotRevalidation = needsSlotRevalidation(draft);
    const prefetchRequired =
      draft != null && channels.availabilityContext == null;

    const outcome = classifyUpgradeForScan({
      schemaVersionBefore: schemaBefore,
      targetSchemaVersion: BOOKING_SCHEMA_VERSION,
      unsupported,
      failClosed,
      expiredHitl: expiredHitl && !failClosed && !unsupported,
      slotRevalidation: slotRevalidation && !failClosed && !unsupported && !expiredHitl,
      prefetchRequired:
        prefetchRequired
        && !expiredHitl
        && !failClosed
        && !unsupported
        && !slotRevalidation,
    });
    counts[outcome] += 1;
  }

  return { counts, extras, dbPath };
};

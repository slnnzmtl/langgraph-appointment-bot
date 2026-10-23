/**
 * Shared booking-aggregate value types (atomic cutover).
 *
 * The BookingSessionV2 bridge has been removed — booking facts live on
 * {@link import("../booking/booking-draft.js").BookingDraft}. This module only exports
 * the small value types folded onto the draft (pending waits, slot provenance,
 * frozen mutation commands). Must stay free of LangGraph / LangChain imports.
 */

/** Provenance for a selected slot; only `availability_tool` is mutation-ready. */
export type SlotProvenance = "availability_tool" | "unverified_legacy" | "none";

/**
 * Snapshot / service / duration / exclusion proof for a verified slot.
 * Required alongside `availability_tool` provenance for a mutation-ready slot.
 */
export type SlotAvailabilityEvidence = {
  snapshotId: string;
  serviceId?: string;
  durationMinutes?: number;
  excludeMeetingIds?: string[];
};

/** Allowlisted CRM row persisted with an open catalog family page. */
export type CatalogRow = {
  id: string;
  name: string;
};

/** One keyboard chip on a catalog family page (group or singleton CRM id). */
export type CatalogChip = {
  id: string;
  label: string;
  serviceIds: string[];
  displayLabel?: string;
};

/**
 * A frozen create/reschedule/cancel write correlated to a prepared effect id.
 * Re-entry with the same frozen write reuses the existing effect id (emit-once).
 */
export type FrozenMutationCommand = {
  action: "create" | "reschedule" | "cancel";
  effectId: string;
  payload: Readonly<Record<string, unknown>>;
};

/**
 * Irreducible waits owned by the aggregate. Ordinary DATE/TIME/contact cards
 * are projections — not independently authoritative.
 */
export type PendingDecision =
  | {
      kind: "service_candidate";
      /** Family probe from list_services.query — partitioner input, not a chip label. */
      query?: string;
      /** Full selected family (id + canonical name) — not truncated servicesContext. */
      catalogRows?: CatalogRow[];
      /** Current keyboard page (groups or leaf CRM chips). */
      choices?: CatalogChip[];
    }
  | {
      kind: "visit_select";
      stage: "action" | "meeting" | "replacement";
      action?: "reschedule" | "cancel";
    }
  | { kind: "service_or_note"; noteCandidate: string; currentServiceId: string }
  | {
      kind: "mutation_confirm";
      action: "create" | "reschedule" | "cancel";
      effectId: string;
      /**
       * Full CRM command the paused interrupt will execute.
       * Compared at resume — missing or mismatched payload declines without a write.
       */
      frozenCommand?: FrozenMutationCommand;
    }
  | {
      kind: "date_select";
      snapshotId: string;
      choiceIds: string[];
      labels: Record<string, string>;
      /** Empty-window DATE page (no open days) — drives patient copy. */
      emptyMode?: "earlier" | "exact" | "other";
    }
  | {
      kind: "time_select";
      date: string;
      snapshotId: string;
      choiceIds: string[];
      labels: Record<string, string>;
    }
  | { kind: "clarification"; reason: string };

/**
 * Shared booking-aggregate value types (atomic cutover).
 *
 * The BookingSessionV2 bridge has been removed — booking facts live on
 * {@link import("../booking-draft.js").BookingDraft}. This module only exports
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

/**
 * Irreducible waits owned by the aggregate. Ordinary DATE/TIME/contact cards
 * are projections — not independently authoritative.
 */
export type PendingDecision =
  | {
      kind: "service_candidate";
      utterance?: string;
      query?: string;
      choiceIds?: string[];
      labels?: Record<string, string>;
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
    }
  | {
      kind: "date_select";
      snapshotId: string;
      choiceIds: string[];
      labels: Record<string, string>;
    }
  | {
      kind: "time_select";
      date: string;
      snapshotId: string;
      choiceIds: string[];
      labels: Record<string, string>;
    }
  | { kind: "clarification"; reason: string };

/**
 * A frozen create/reschedule/cancel write correlated to a prepared effect id.
 * Re-entry with the same frozen write reuses the existing effect id (emit-once).
 */
export type FrozenMutationCommand = {
  action: "create" | "reschedule" | "cancel";
  effectId: string;
  payload: Readonly<Record<string, unknown>>;
};

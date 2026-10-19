/**
 * Canonical booking aggregate (DDD-273 / Phase 1).
 * Checkpointed in the existing `bookingDraft` channel (schema version 2).
 */

export const BOOKING_SESSION_SCHEMA_VERSION = 2 as const;

export type BookingModeV2 = "create" | "reschedule" | "replace";

export type ServiceRef = {
  id: string;
  name?: string;
  durationMinutes?: number;
  source: "catalog" | "direct" | "crm";
};

export type ServiceAcceptanceV2 = {
  status: "pending" | "accepted";
  service: ServiceRef;
  acceptedAtTurn?: number;
};

/** Selected slot facts without treating cursor/cache as provenance. */
export type SlotFacts = {
  slotId?: string;
  dateStart: string;
  dateEnd: string;
  label: string;
  /** Provenance required before the slot is selectable / mutable. */
  provenance: "availability_tool" | "unverified_legacy" | "none";
};

export type NoteFacts = {
  status: "unasked" | "awaiting" | "skipped" | "answered";
  value?: string;
};

export type ContactFacts = {
  contactId: string | null;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  phoneLookup?: {
    phoneNumber: string;
    result: "none" | "single_linkable" | "occupied" | "ambiguous";
    contactIds: string[];
  } | null;
};

export type MeetingRef = {
  id: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

export type ReplacementFacts = {
  meeting: MeetingRef;
  status: "offered" | "cancelling" | "create_pending";
  originalCommand?: FrozenMutationCommand | null;
};

/** Frozen mutation awaiting HITL / ToolNode — command idempotency, not event sourcing. */
export type FrozenMutationCommand = {
  action: BookingModeV2 | "cancel";
  payload: Readonly<Record<string, unknown>>;
};

/**
 * Irreducible waits owned by the session. Ordinary DATE/TIME/contact cards
 * are projections — not independently authoritative.
 */
export type PendingDecision =
  | { kind: "service_candidate"; utterance?: string; query?: string }
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
  | { kind: "clarification"; reason: string };

export type BookingSessionV2 = {
  schemaVersion: typeof BOOKING_SESSION_SCHEMA_VERSION;
  revision: number;
  mode: BookingModeV2;
  serviceAcceptance: ServiceAcceptanceV2 | null;
  selectedDate: string | null;
  selectedSlot: SlotFacts | null;
  requestedTime: { value: string; status: "pending" | "unavailable" } | null;
  note: NoteFacts;
  contact: ContactFacts;
  rescheduleTarget: MeetingRef | null;
  replacement: ReplacementFacts | null;
  pendingDecision: PendingDecision | null;
  /** Frozen CRM mutation command (maps from legacy pendingCommand). */
  pendingCommand: FrozenMutationCommand | null;
  /** Placeholder until Phase 2 enforces PendingEffect lifecycle. */
  pendingEffect: null;
};

export type SlotProvenance = SlotFacts["provenance"];

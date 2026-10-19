/**
 * Reusable fixture data for later DDD-271 phases (DDD-272 Phase 0).
 * These are data only — not failing assertions. Phase 4 / 6A acceptance is
 * documented in analysis/booking-workflow-simplification-implementation-plan.md.
 */

import type { UnderstoodBookingTurn } from "../../booking-domain/turn.js";
import type { BookingSessionV2 } from "../../booking-domain/session.js";

/** Multi-fact create turn: service + schedule + phone in one utterance. */
export const multiFactCreatePatch: UnderstoodBookingTurn = {
  serviceIntent: { kind: "named_procedure", query: "Botox" },
  scheduleIntent: { kind: "date_and_time", date: "2026-10-24", time: "13:00" },
  contactFacts: { phoneNumber: "+380501112233" },
};

/** Hours/address aside while DATE/TIME is open — informational only. */
export const hoursAsideDuringDateSelect: UnderstoodBookingTurn = {
  informationalQuestion: "Який у вас графік роботи?",
};

export const addressAsideDuringTimeSelect: UnderstoodBookingTurn = {
  informationalQuestion: "Яка адреса клініки?",
};

/**
 * Minimal schema-2 session sketch for fixture composition in later phases.
 * Not a production checkpoint shape until DDD-273.
 */
export const sketchSessionAfterServiceAccepted = (): BookingSessionV2 => ({
  schemaVersion: 2,
  revision: 1,
  mode: "create",
  serviceAcceptance: {
    status: "accepted",
    service: { id: "svc-botox", name: "Botox", source: "catalog" },
  },
  selectedDate: null,
  selectedSlot: null,
  requestedTime: null,
  note: { status: "unasked" },
  contact: { contactId: null },
  rescheduleTarget: null,
  replacement: null,
  pendingDecision: null,
  pendingCommand: null,
  pendingEffect: null,
});

/**
 * Marker for a paused HITL checkpoint blob fixture (Phase 5 / 6A).
 * The serialized MemorySaver/SqliteSaver row is supplied by Phase 5 tests;
 * this constant documents the expected interrupt type and node name.
 */
export const pausedHitlCheckpointMeta = {
  interruptType: "confirm_booking" as const,
  resumeNodeName: "booking__tools" as const,
  action: "create" as const,
  /** Phase 5/6A must recover without CRM write and without missing-node errors. */
  expectedRecovery: "expired_confirmation" as const,
};

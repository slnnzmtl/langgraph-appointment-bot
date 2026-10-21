import type { BookingEvent } from "../booking-draft.js";
import type { CatalogChip } from "./session.js";
import type { EffectResult, PendingEffect } from "./effects.js";
import type { UnderstoodBookingTurn } from "./turn.js";

/**
 * Outputs of decideBooking (atomic cutover).
 *
 * The kernel never returns a modified draft and never carries patient prose.
 * A decision is a semantic intent + verified facts + choice-id card. Graph
 * adapters map intents/facts/cards to patient-facing copy.
 */

/**
 * Closed set of patient-facing intents the kernel can express. Copy lives in
 * the adapter; the kernel only names the intent and supplies verified facts.
 */
export type BookingSemanticIntent =
  | "ask_phone"
  | "ask_first_name"
  | "ask_last_name"
  | "ask_service"
  | "ask_note"
  | "confirm_service"
  | "present_dates"
  | "present_times"
  | "confirm_create"
  | "confirm_reschedule"
  | "confirm_cancel"
  | "answer_side_question"
  | "success"
  | "mutation_failed"
  | "clarification"
  | "handoff"
  | "menu"
  | "abandon"
  | "need_interpreter"
  | "run_effect"
  | "idle";

/**
 * Verified facts a decision may carry. Only allowlisted values — never raw
 * tool text or free-form patient prose.
 */
export type BookingVerifiedFacts = {
  serviceId?: string;
  serviceName?: string;
  date?: string;
  time?: string;
  /** Kyiv-local ISO start of the selected slot (for visit-label success copy). */
  dateStart?: string;
  address?: string;
  hours?: string;
  servicePrice?: string;
  effectId?: string;
  failureCode?: string;
  action?: "create" | "reschedule" | "cancel";
  clarificationReason?: string;
  nextStep?: string;
};

/**
 * Choice-id only cards (no replyText, no plain prose). The adapter resolves
 * choice ids / clarification reason codes to localized copy.
 */
export type BookingViewCard =
  | { kind: "service_confirm"; serviceId: string; choiceIds: string[]; labels?: Record<string, string> }
  | {
      kind: "service_candidate";
      choiceIds: string[];
      labels?: Record<string, string>;
      displayLabels?: Record<string, string>;
      serviceIdsByChoice?: Record<string, string[]>;
    }
  | {
      kind: "date_select";
      snapshotId: string;
      choiceIds: string[];
      labels?: Record<string, string>;
      /** Empty-window DATE page (no open days) — drives patient copy. */
      emptyMode?: "earlier" | "exact" | "other";
    }
  | {
      kind: "time_select";
      date: string;
      snapshotId: string;
      choiceIds: string[];
      labels?: Record<string, string>;
    }
  | { kind: "visit_note"; skipChoiceId: string }
  | { kind: "contact_field"; field: "phoneNumber" | "firstName" | "lastName" }
  | { kind: "visit_select"; stage: "action" | "meeting" | "replacement" }
  | { kind: "mutation_confirm"; action: "create" | "reschedule" | "cancel"; effectId: string }
  | { kind: "clarification"; reason: string };

export type BookingDecisionTag =
  | "ask"
  | "effect"
  | "reply"
  | "mutation_confirm"
  | "terminal";

export type BookingTerminalReason =
  | "abandon"
  | "handoff"
  | "menu"
  | "success"
  | "failed";

/**
 * A single decision. No `session`, no `replyText`. The decide node applies the
 * accompanying events (see {@link DecideBookingResult}); the adapter renders
 * `intent` + `facts` + `card`.
 */
export type BookingDecision = {
  tag: BookingDecisionTag;
  intent: BookingSemanticIntent;
  facts: BookingVerifiedFacts;
  card: BookingViewCard | null;
  pendingEffect?: PendingEffect;
  reason?: BookingTerminalReason | string;
};

/**
 * The sole output of {@link import("./decide.js").decideBooking}: a list of
 * events the decide node applies via reduceBookingDraft, and the decision that
 * describes what to tell the patient. NEVER a modified draft.
 */
export type DecideBookingResult = {
  events: BookingEvent[];
  decision: BookingDecision;
};

/** Allowlisted open-day slots the adapter may pass for choice → slot resolution. */
export type AvailabilitySlotReadModel = {
  id: string;
  label: string;
  dateStart: string;
  dateEnd: string;
};

/** Allowlisted planned visit for preemptive REPLACE (id + display fields only). */
export type PlannedMeetingReadModel = {
  id: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

/** CRM / availability read models passed into decideBooking (not a second aggregate). */
export type BookingReadModels = {
  contactContextDirty: boolean;
  bookingContextDirty: boolean;
  availabilityVerified: boolean;
  /** Open days from the latest availability snapshot (allowlisted fields only). */
  availabilityDays?: Array<{
    date: string;
    dayLabel?: string;
    slots: AvailabilitySlotReadModel[];
  }>;
  availabilitySnapshotId?: string;
  /** Prefetched planned meetings (REPLACE gate). */
  plannedMeetings?: PlannedMeetingReadModel[];
  /**
   * Telegram-owned CRM names when identity is resolved.
   * Used for create_meeting titles after contactDetails were cleared.
   */
  ownedContact?: { firstName?: string; lastName?: string };
};

/**
 * Interpreter / patient / effect input envelope for the kernel.
 * Distinct from {@link import("./turn.js").UnderstoodBookingTurn} which is the
 * semantic patch produced by the turn interpreter.
 */
export type BookingInput =
  | { source: "patient_turn"; rawText: string }
  | { source: "semantic_patch"; patch: UnderstoodBookingTurn }
  | { source: "effect_result"; result: EffectResult }
  | {
      source: "catalog_page";
      remainingIds: string[];
      choices: CatalogChip[];
    }
  | { source: "control"; intent: "menu" | "abandon" | "handoff" };

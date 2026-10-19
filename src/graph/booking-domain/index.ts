/**
 * Canonical booking decision-loop contracts (DDD-272+) and Phase 1 session helpers.
 * Must stay free of LangGraph / LangChain imports (depcruise).
 */

export {
  BOOKING_SESSION_SCHEMA_VERSION,
  type BookingModeV2,
  type BookingSessionV2,
  type ContactFacts,
  type FrozenMutationCommand,
  type MeetingRef,
  type NoteFacts,
  type PendingDecision,
  type ReplacementFacts,
  type ServiceAcceptanceV2,
  type ServiceRef,
  type SlotAvailabilityEvidence,
  type SlotFacts,
  type SlotProvenance,
} from "./session.js";

export {
  pendingDecisionFromLegacyInteraction,
  schema2FieldsForUpgradedDraft,
  withSchema2SessionFields,
} from "./upgrade-session.js";

export {
  type BookingEffect,
  type EffectResult,
  type PendingEffect,
  type PendingEffectStatus,
} from "./effects.js";

export {
  type BookingDecision,
  type BookingInput,
  type BookingReadModels,
  type BookingView,
  type BookingViewCard,
} from "./decision.js";

export {
  type ContactPatch,
  type ControlIntent,
  type NoteInput,
  type ScheduleIntent,
  type SemanticChoice,
  type ServiceIntent,
  type UnderstoodBookingTurn,
} from "./turn.js";

export {
  nextBookingRequirement,
  type BookingRequirement,
  type NextBookingRequirement,
} from "./requirement.js";

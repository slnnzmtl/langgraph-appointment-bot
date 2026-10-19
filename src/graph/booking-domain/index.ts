/**
 * Canonical booking decision-loop contracts (DDD-272 / Phase 0).
 *
 * Compile-only in this phase: no production routing imports these symbols for
 * control flow. Later phases implement decideBooking / projectBookingView against
 * these types. Must stay free of LangGraph / LangChain imports (depcruise).
 */

export {
  BOOKING_SESSION_SCHEMA_VERSION,
  type BookingModeV2,
  type BookingSessionV2,
  type ContactFacts,
  type MeetingRef,
  type NoteFacts,
  type PendingDecision,
  type ReplacementFacts,
  type ServiceAcceptanceV2,
  type ServiceRef,
  type SlotFacts,
} from "./session.js";

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

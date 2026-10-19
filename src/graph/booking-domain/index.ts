/**
 * Canonical booking decision-loop (atomic cutover).
 *
 * decideBooking is pure: it returns events (applied by the decide node via
 * reduceBookingDraft) plus a prose-free decision. Must stay free of
 * LangGraph / LangChain imports (depcruise).
 */

export {
  type FrozenMutationCommand,
  type PendingDecision,
  type SlotAvailabilityEvidence,
  type SlotProvenance,
} from "./session.js";

export {
  type BookingEffect,
  type EffectResult,
  type InformationalFacts,
  type PendingEffect,
  type PendingEffectStatus,
} from "./effects.js";

export {
  type BookingDecision,
  type BookingDecisionTag,
  type BookingInput,
  type BookingReadModels,
  type BookingSemanticIntent,
  type BookingTerminalReason,
  type BookingVerifiedFacts,
  type BookingViewCard,
  type DecideBookingResult,
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

export { decideBooking } from "./decide.js";

export {
  interpretBookingTurnDeterministic,
  normalizeBookingTurnClassification,
  BOOKING_TURN_INTERPRETER_INSTRUCTION,
  type InterpretBookingTurnInput,
  type InterpretChoice,
  type BookingTurnClassification,
} from "./interpret.js";

/** Agent-loop package: prepare / command / llm / tools / finalize nodes. */

export {
  type MeetingMutationOutcome,
  captureAvailabilityFromMessages,
  captureLatestToolContext,
  captureServicesFromMessages,
  classifyContactWriteToolMessage,
  classifyMeetingMutationToolMessage,
  createMeetingAlreadyBooked,
  terminalContactWriteOutcome,
  phoneLookupFailedThisTurn,
  crmWriteDirtiesPrefetch,
  meetingMutationClearsAvailability,
} from "./protocol/index.js";

export {
  bookingOutcomeRiskState,
} from "./booking-command.js";

export {
  advanceBookingNoteStep,
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  noteStepBlocksCreate,
} from "./booking-note-step.js";

export {
  availabilityOfferFromToolTurn,
  formatAvailabilityDateOffer,
  formatAvailabilityEmptyOffer,
  formatAvailabilityHeading,
  formatAvailabilityTimeOffer,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  resolveAvailabilityOffer,
} from "../booking-interaction-render.js";

export {
  createAgentMutationFinalizeNode,
  defaultMenuHasVisit,
} from "./mutation-finalize.js";

export {
  createAgentCommandPrepareNode,
} from "./command-prepare.js";

export {
  createBookingFinalizeNode,
  createFaqFinalizeNode,
  offeredServiceForTurn,
} from "./finalize/index.js";

export {
  type CreateAgentLlmOptions,
  createAgentLlmNode,
} from "./llm.js";

export {
  type CreateBookingPrepareOptions,
  type CreateFaqPrepareOptions,
  createBookingPrepareNode,
  createFaqPrepareNode,
} from "./prepare/index.js";

export {
  createAgentToolsNode,
} from "./tools.js";

export {
  type RouteAfterAgentToolsOptions,
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "./routing.js";

export { rewriteAiMessage } from "./rewrite-ai-message.js";
export { sanitizeBoundModelToolCalls } from "./tool-call-coercion.js";

export {
  commandPrepareNodeName,
  finalizeNodeName,
  llmNodeName,
  mutationFinalizeNodeName,
  prepareNodeName,
  toolsNodeName,
} from "./nodes-names.js";

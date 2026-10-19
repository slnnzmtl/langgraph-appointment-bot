/** Agent-loop package: FAQ prepare / llm / tools / finalize + booking decide/respond. */

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
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
} from "./booking-note-step.js";

export {
  createAgentMutationFinalizeNode,
  defaultMenuHasVisit,
} from "./mutation-finalize.js";

export {
  createFaqFinalizeNode,
  offeredServiceForTurn,
} from "./finalize/index.js";

export {
  type CreateAgentLlmOptions,
  createAgentLlmNode,
} from "./llm.js";

export {
  type CreateFaqPrepareOptions,
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
  applyMutationChatOtherCleanup,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
} from "./mutation-chat-other.js";

export {
  finalizeNodeName,
  llmNodeName,
  mutationFinalizeNodeName,
  prepareNodeName,
  toolsNodeName,
} from "./nodes-names.js";

export {
  BOOKING_DECIDE_NODE,
  BOOKING_EFFECTS_NODE,
  createBookingDecideNode,
  effectResultFromToolMessages,
  readModelsFromClinicState,
} from "./booking-decide-nodes.js";

export {
  BOOKING_RESPOND_NODE,
  createBookingRespondNode,
} from "./booking-respond.js";

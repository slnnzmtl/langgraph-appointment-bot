/** Agent-loop package: prepare / command / llm / tools / finalize nodes. */

export {
  type MeetingMutationOutcome,
  advanceBookingNoteStep,
  availabilityOfferFromToolTurn,
  captureAvailabilityFromMessages,
  captureLatestToolContext,
  captureServicesFromMessages,
  classifyMeetingMutationToolMessage,
  createMeetingAlreadyBooked,
  crmWriteDirtiesPrefetch,
  formatAvailabilityDateOffer,
  formatAvailabilityEmptyOffer,
  formatAvailabilityHeading,
  formatAvailabilityTimeOffer,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  meetingMutationClearsAvailability,
  resolveAvailabilityOffer,
} from "./shared.js";

export {
  createAgentMutationFinalizeNode,
  defaultMenuHasVisit,
} from "./mutation-finalize.js";

export {
  createAgentCommandPrepareNode,
} from "./command-prepare.js";

export {
  createAgentFinalizeNode,
} from "./finalize.js";

export {
  type CreateAgentLoopOptions,
  type CreateAgentPrepareOptions,
  commandPrepareNodeName,
  createAgentLlmNode,
  createAgentPrepareNode,
  createAgentToolsNode,
  finalizeNodeName,
  llmNodeName,
  mutationFinalizeNodeName,
  prepareNodeName,
  routeAfterAgentLlm,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
  toolsNodeName,
} from "./nodes.js";


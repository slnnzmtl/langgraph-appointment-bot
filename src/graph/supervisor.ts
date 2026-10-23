/**
 * Clinic supervisor — barrel re-export.
 * Implementation lives under {@link ./supervisor/}.
 */

export {
  createClinicSupervisorNode,
  PREFETCH_TTL_MS,
  type CreateClinicSupervisorNodeOptions,
  type SupervisorContextCacheOptions,
} from "./supervisor/node.js";
export { isPrefetchExpired } from "./supervisor/context.js";
export {
  classifyCancelTap,
  isGreetingOrMainMenuLine,
  isDayOrTimeReply,
  isOtherDateReply,
  isPendingRescheduleSelection,
} from "./supervisor/routing-predicates.js";
export { isVisitStatusSignal } from "./supervisor/visit-status.js";

import type { SupervisorIntent } from "../routing.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "../types.js";

/** Specialist that owns a free-text supervisor intent; null keeps the model's `next`. */
export const specialistForSupervisorIntent = (
  intent: SupervisorIntent | undefined,
): typeof BOOKING_AGENT_ID | typeof FAQ_AGENT_ID | null => {
  switch (intent) {
    case "visit_cancel":
    case "visit_reschedule":
    case "book":
    case "consultation_request":
      return BOOKING_AGENT_ID;
    case "faq":
      return FAQ_AGENT_ID;
    default:
      return null;
  }
};

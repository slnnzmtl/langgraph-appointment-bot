import { FAQ_SYSTEM_PROMPT } from "../prompts/faq.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
  type ClinicSpecialists,
} from "../graph/types.js";

export const faqAgent: ClinicAgentDefinition = {
  id: FAQ_AGENT_ID,
  name: "FAQ",
  description: "Answers clinic FAQ: hours, services, pricing, and general information.",
  systemPrompt: FAQ_SYSTEM_PROMPT,
  maxSteps: 4,
};

/**
 * Booking has no LLM node — decide/effect/respond owns the path.
 * Keep the specialist id for tools allowlist and route targets.
 * systemPrompt is intentionally empty (archival copy lives in prompts/booking.ts).
 */
export const bookingAgent: ClinicAgentDefinition = {
  id: BOOKING_AGENT_ID,
  name: "Booking",
  description: "Books clinic appointments: identify patient, collect details, schedule meetings.",
  systemPrompt: "",
  maxSteps: 10,
};

export const clinicSpecialists: ClinicSpecialists = {
  faq: faqAgent,
  booking: bookingAgent,
};

/** @deprecated Prefer `clinicSpecialists`. */
export const clinicAgents: ClinicAgentDefinition[] = [faqAgent, bookingAgent];

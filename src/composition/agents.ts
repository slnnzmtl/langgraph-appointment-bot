import { BOOKING_SYSTEM_PROMPT } from "../prompts/booking.js";
import { FAQ_SYSTEM_PROMPT } from "../prompts/faq.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../graph/types.js";

export const faqAgent: ClinicAgentDefinition = {
  id: FAQ_AGENT_ID,
  name: "FAQ",
  description: "Answers clinic FAQ: hours, services, pricing, and general information.",
  systemPrompt: FAQ_SYSTEM_PROMPT,
  maxSteps: 4,
};

export const bookingAgent: ClinicAgentDefinition = {
  id: BOOKING_AGENT_ID,
  name: "Booking",
  description: "Books clinic appointments: identify patient, collect details, schedule meetings.",
  systemPrompt: BOOKING_SYSTEM_PROMPT,
  maxSteps: 10,
};

export const clinicAgents: ClinicAgentDefinition[] = [faqAgent, bookingAgent];

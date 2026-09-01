import { BOOKING_SYSTEM_PROMPT } from "../prompts/booking.js";
import {
  BOOKING_AGENT_ID,
  type ClinicAgentDefinition,
} from "../graph/types.js";

export const bookingAgent: ClinicAgentDefinition = {
  id: BOOKING_AGENT_ID,
  name: "Booking",
  description:
    "Answers clinic FAQ (hours, services, prices, location) and books, moves, or cancels visits.",
  systemPrompt: BOOKING_SYSTEM_PROMPT,
  maxSteps: 10,
};

export const clinicAgents: ClinicAgentDefinition[] = [bookingAgent];

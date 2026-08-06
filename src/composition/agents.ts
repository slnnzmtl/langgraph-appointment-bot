import type { CreateRuntimeAgentInput } from "@personal-assistant/supervisor-framework";

import { BOOKING_SYSTEM_PROMPT } from "../prompts/booking.js";
import { FAQ_SYSTEM_PROMPT } from "../prompts/faq.js";
import {
  ESPOCRM_BOOKING_CAPABILITY_ID,
  ESPOCRM_READ_CAPABILITY_ID,
} from "./clinic-capability-providers.js";

export const faqAgentInput: CreateRuntimeAgentInput = {
  name: "FAQ",
  description: "Answers clinic FAQ: hours, services, pricing, and general information.",
  systemPrompt: FAQ_SYSTEM_PROMPT,
  capabilityIds: [ESPOCRM_READ_CAPABILITY_ID],
  modelKey: "generic",
  maxSteps: 4,
  enabled: true,
};

export const bookingAgentInput: CreateRuntimeAgentInput = {
  name: "Booking",
  description: "Books clinic appointments: identify patient, collect details, schedule meetings.",
  systemPrompt: BOOKING_SYSTEM_PROMPT,
  capabilityIds: [ESPOCRM_BOOKING_CAPABILITY_ID],
  modelKey: "generic",
  maxSteps: 10,
  enabled: true,
};

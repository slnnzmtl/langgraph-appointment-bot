import {
  NONE_CAPABILITY_ID,
  type CreateRuntimeAgentInput,
} from "@personal-assistant/supervisor-framework";

import { BOOKING_SYSTEM_PROMPT } from "../prompts/booking.js";
import { FAQ_SYSTEM_PROMPT } from "../prompts/faq.js";

/** Phase 1: both agents use `none` until EspoCRM MCP capabilities land in Phase 2. */
export const faqAgentInput: CreateRuntimeAgentInput = {
  name: "FAQ",
  description: "Answers clinic FAQ: hours, services, pricing, and general information.",
  systemPrompt: FAQ_SYSTEM_PROMPT,
  capabilityIds: [NONE_CAPABILITY_ID],
  modelKey: "generic",
  maxSteps: 4,
  enabled: true,
};

export const bookingAgentInput: CreateRuntimeAgentInput = {
  name: "Booking",
  description: "Books clinic appointments: identify patient, collect details, schedule meetings.",
  systemPrompt: BOOKING_SYSTEM_PROMPT,
  capabilityIds: [NONE_CAPABILITY_ID],
  modelKey: "generic",
  maxSteps: 8,
  enabled: true,
};

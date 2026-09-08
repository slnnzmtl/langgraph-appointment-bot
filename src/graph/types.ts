export type { ILLMConnector } from "@personal-assistant/llm-gemini";

import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";

export const FINISH_ROUTE = "FINISH" as const;
export const FAQ_AGENT_ID = "faq" as const;
export const BOOKING_AGENT_ID = "booking" as const;

export type ClinicAgentId = typeof FAQ_AGENT_ID | typeof BOOKING_AGENT_ID;
export type ClinicRouteId = ClinicAgentId | typeof FINISH_ROUTE;

export type ClinicAgentDefinition = {
  id: ClinicAgentId;
  name: string;
  description: string;
  systemPrompt: string;
  maxSteps: number;
};

export type ClinicHandoffStatus = "ok" | "empty" | "max_steps" | "error";

export type ClinicHandoff = {
  agentId: string;
  agentName: string;
  status: ClinicHandoffStatus;
  /** Patient-facing text for this handoff (adapter prefers over scanning history). */
  replyText?: string;
  /** Labels from the last agent reply trailer (stripped from checkpointed text). */
  replyButtons?: string[];
  /** When true, the next patient message must go through the supervisor. */
  yieldToSupervisor?: boolean;
};

/**
 * Optional visit-note ladder after a start time is chosen.
 * Always ask once; skip only via shortcut / decline / a real note — then create_meeting may run.
 */
export type BookingNoteStatus = "unasked" | "awaiting" | "skipped" | "answered";

/** Matched free slot held while the note step runs (ISO local wall times from availability). */
export type SelectedBookingSlot = {
  dateStart: string;
  dateEnd: string;
  label: string;
};

/** Contact + upcoming meetings loaded at supervisor entry (TTL / dirty-gated). */
export type AgentPrefetchResult = {
  contactContext: ContactLookupContext;
  bookingContext: BookingContext | null;
};

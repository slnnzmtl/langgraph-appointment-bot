import type { StructuredToolInterface } from "@langchain/core/tools";

import { createContactTools } from "./contact-tools.js";
import { createMeetingTools, type MeetingToolsOptions } from "./meeting-tools.js";

export type { ContactLookupContext, ContactToolsOptions } from "./contact-tools.js";
export {
  createContactTools,
  extractContactIdFromSearchResult,
  lookupContactByTelegram,
  normalizeContactLookupResult,
} from "./contact-tools.js";

export type { BookingContext, ListedMeeting, MeetingToolsOptions } from "./meeting-tools.js";
export { createMeetingTools, lookupPlannedMeetings } from "./meeting-tools.js";

export type { GetWorkingTimeArgs, ReadToolsOptions } from "./service-tools.js";
export { createReadTools, getWorkingTime, listServices } from "./service-tools.js";

export type BookingToolsOptions = MeetingToolsOptions;

/**
 * Tools the booking LLM must never bind. ToolNode still executes them when
 * command_prepare (or other runtime) injects the calls. Includes
 * list_planned_meetings — supervisor prefetch is the authoritative visit source.
 */
export const BOOKING_RUNTIME_TOOL_NAMES = new Set([
  "present_availability_slots",
  "find_contact_by_phone",
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "list_planned_meetings",
  "cancel_meeting",
  "reschedule_meeting",
]);

export const isBookingRuntimeToolName = (name: string): boolean =>
  BOOKING_RUNTIME_TOOL_NAMES.has(name);

/** Positive allowlist for the booking LLM. Unknown tools stay runtime-only. */
export const BOOKING_INFORMATIONAL_TOOL_NAMES = new Set([
  "list_services",
  "get_service",
  "get_working_time",
]);

/** Model-visible booking tools: FAQ-style reads only. */
export const filterBookingInformationalTools = (
  tools: readonly StructuredToolInterface[],
): StructuredToolInterface[] =>
  tools.filter((tool) => BOOKING_INFORMATIONAL_TOOL_NAMES.has(tool.name));

export const createBookingTools = (options: BookingToolsOptions): StructuredToolInterface[] => [
  ...createContactTools({ callTool: options.callTool }),
  ...createMeetingTools(options),
];

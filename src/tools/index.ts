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

export const createBookingTools = (options: BookingToolsOptions): StructuredToolInterface[] => [
  ...createContactTools({ callTool: options.callTool }),
  ...createMeetingTools(options),
];

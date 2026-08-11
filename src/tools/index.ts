import type { StructuredToolInterface } from "@langchain/core/tools";

import { createContactTools } from "./contact-tools.js";
import { createMeetingTools, type MeetingToolsOptions } from "./meeting-tools.js";

export type { ContactToolsOptions } from "./contact-tools.js";
export { createContactTools, lookupContactByTelegram } from "./contact-tools.js";

export type { MeetingToolsOptions } from "./meeting-tools.js";
export { createMeetingTools } from "./meeting-tools.js";

export type { GetWorkingTimeArgs, ReadToolsOptions } from "./service-tools.js";
export { createReadTools, getWorkingTime, listServices } from "./service-tools.js";

export type BookingToolsOptions = MeetingToolsOptions;

export const createBookingTools = (options: BookingToolsOptions): StructuredToolInterface[] => [
  ...createContactTools({ callTool: options.callTool }),
  ...createMeetingTools(options),
];

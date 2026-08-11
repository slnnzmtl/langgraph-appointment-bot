import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { BookingContext } from "../tools/meeting-tools.js";

export type AgentPrefetchResult = {
  contactContext: ContactLookupContext;
  bookingContext: BookingContext | null;
};

// Uncached dynamic LLM blocks (Gemini 3 drops synthetic functionCall parts without thoughtSignature).

export const formatListedMeetingsContext = (ctx: BookingContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  return `<list_planned_meetings>\n${JSON.stringify({ meetings: ctx.meetings, dateFrom: ctx.dateFrom })}\n</list_planned_meetings>`;
};

export const formatContactContext = (ctx: ContactLookupContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  return `<contact_info>\n${JSON.stringify(ctx)}\n</contact_info>`;
};

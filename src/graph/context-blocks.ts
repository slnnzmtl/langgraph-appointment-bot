import { formatKyivDateTimeLabel, formatKyivLocalIso } from "../tools/availability-slots.js";
import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";

export type AgentPrefetchResult = {
  contactContext: ContactLookupContext;
  bookingContext: BookingContext | null;
};

// Uncached dynamic LLM blocks (Gemini 3 drops synthetic functionCall parts without thoughtSignature).

export const formatListedMeetingsContext = (ctx: BookingContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  const today = formatKyivLocalIso(new Date()).slice(0, 10);
  // whenLabel is precomputed so the model quotes a date instead of formatting one.
  const meetings = ctx.meetings.map((meeting) => ({
    ...meeting,
    whenLabel: formatKyivDateTimeLabel(meeting.dateStart, today),
  }));
  return `<list_planned_meetings>\n${JSON.stringify({ meetings, dateFrom: ctx.dateFrom })}\n</list_planned_meetings>`;
};

export const formatContactContext = (ctx: ContactLookupContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  return `<contact_info>\n${JSON.stringify(ctx)}\n</contact_info>`;
};

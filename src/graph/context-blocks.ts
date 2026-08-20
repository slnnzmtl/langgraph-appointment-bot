import { formatKyivDateTimeLabel, formatKyivLocalIso } from "../tools/availability-slots.js";
import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";

export type AgentPrefetchResult = {
  contactContext: ContactLookupContext;
  bookingContext: BookingContext | null;
};

/** CRM titles are "[service-name] - [firstName lastName]"; last " - " is the patient, not the service. */
export const meetingServiceLabel = (name: string): string => {
  const separator = name.lastIndexOf(" - ");
  if (separator <= 0) {
    return name.trim();
  }
  const service = name.slice(0, separator).trim();
  return service.length > 0 ? service : name.trim();
};

// Uncached dynamic LLM blocks (Gemini 3 drops synthetic functionCall parts without thoughtSignature).

export const formatListedMeetingsContext = (ctx: BookingContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  const today = formatKyivLocalIso(new Date()).slice(0, 10);
  // visitLabel / whenLabel are precomputed so the model quotes them instead of inventing a service or date.
  const meetings = ctx.meetings.map((meeting) => {
    const whenLabel = formatKyivDateTimeLabel(meeting.dateStart, today);
    const serviceLabel = meetingServiceLabel(meeting.name);
    return {
      ...meeting,
      serviceLabel,
      whenLabel,
      visitLabel: `${serviceLabel} - ${whenLabel}`,
    };
  });
  const body = JSON.stringify({ meetings, dateFrom: ctx.dateFrom });
  const moveHint =
    meetings.length > 0
      ? "\nWhen moving or cancelling, name serviceLabel from this block only — never a procedure from earlier chat."
      : "";
  return `<list_planned_meetings>\n${body}${moveHint}\n</list_planned_meetings>`;
};

export const formatContactContext = (ctx: ContactLookupContext | null | undefined): string => {
  if (!ctx) {
    return "";
  }
  return `<contact_info>\n${JSON.stringify(ctx)}\n</contact_info>`;
};

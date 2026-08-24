import { formatKyivDateTimeLabel, formatKyivLocalIso } from "../tools/availability-slots.js";
import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";

export type AgentPrefetchResult = {
  contactContext: ContactLookupContext;
  bookingContext: BookingContext | null;
};

export type MeetingsContextMode = "booking" | "faq" | "supervisor";

/** CRM titles are "[service-name] - [firstName lastName]"; last " - " is the patient, not the service. */
export const meetingServiceLabel = (name: string): string => {
  const separator = name.lastIndexOf(" - ");
  if (separator <= 0) {
    return name.trim();
  }
  const service = name.slice(0, separator).trim();
  return service.length > 0 ? service : name.trim();
};

const visitLabelForMeeting = (
  meeting: { name: string; dateStart: string },
  today: string,
): string => {
  const whenLabel = formatKyivDateTimeLabel(meeting.dateStart, today);
  const serviceLabel = meetingServiceLabel(meeting.name);
  return `${serviceLabel} - ${whenLabel}`;
};

// Uncached dynamic LLM blocks (Gemini 3 drops synthetic functionCall parts without thoughtSignature).

export const formatListedMeetingsContext = (
  ctx: BookingContext | null | undefined,
  mode: MeetingsContextMode = "booking",
): string => {
  if (mode === "faq") {
    const has = (ctx?.meetings.length ?? 0) > 0;
    return `<planned_visits>${has ? "has" : "none"}</planned_visits>`;
  }

  if (!ctx) {
    return "";
  }

  const today = formatKyivLocalIso(new Date()).slice(0, 10);

  if (mode === "supervisor") {
    const visitLabels = ctx.meetings.map((meeting) => visitLabelForMeeting(meeting, today));
    return `<list_planned_meetings>\n${JSON.stringify({ visitLabels })}\n</list_planned_meetings>`;
  }

  // visitLabel is precomputed so the model quotes it instead of inventing a service or date.
  const meetings = ctx.meetings.map((meeting) => ({
    id: meeting.id,
    name: meeting.name,
    dateStart: meeting.dateStart,
    dateEnd: meeting.dateEnd,
    visitLabel: visitLabelForMeeting(meeting, today),
  }));
  const body = JSON.stringify({ meetings, dateFrom: ctx.dateFrom });
  const moveHint =
    meetings.length > 0
      ? "\nWhen moving or cancelling, quote visitLabel from this block only — never a procedure from earlier chat."
      : "";
  return `<list_planned_meetings>\n${body}${moveHint}\n</list_planned_meetings>`;
};

export const formatContactContext = (
  ctx: ContactLookupContext | null | undefined,
  mode: "full" | "greeting" = "full",
): string => {
  if (!ctx) {
    return "";
  }
  if (mode === "greeting") {
    const firstName = ctx.contacts[0]?.firstName;
    const payload = {
      firstName:
        typeof firstName === "string" && firstName.trim().length > 0 ? firstName.trim() : null,
    };
    return `<contact_info>\n${JSON.stringify(payload)}\n</contact_info>`;
  }
  return `<contact_info>\n${JSON.stringify(ctx)}\n</contact_info>`;
};

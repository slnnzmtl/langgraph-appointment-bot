import { CONTEXT_TAGS } from "../shared/clinic-constants.js";
import { formatKyivDateTimeLabel, kyivToday } from "../tools/availability-slots.js";
import type { AvailabilityContext } from "../tools/availability-tools.js";
import type { ContactLookupContext } from "../tools/contact-tools.js";
import type { ServicesContext } from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";

export { CONTEXT_TAGS };

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

const block = (tag: string, payload: unknown, trailer = ""): string =>
  `<${tag}>\n${JSON.stringify(payload)}${trailer}\n</${tag}>`;

/** FAQ-only flag for DEFAULT MENU («Записатись» vs «Мій запис»). Emits even when ctx is null. */
export const formatPlannedVisitsFlag = (
  ctx: BookingContext | null | undefined,
): string => {
  const has = (ctx?.meetings.length ?? 0) > 0;
  return `<${CONTEXT_TAGS.plannedVisits}>${has ? "has" : "none"}</${CONTEXT_TAGS.plannedVisits}>`;
};

/** Supervisor: visitLabels only (no meeting ids). */
export const formatSupervisorVisitLabels = (
  ctx: BookingContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  const today = kyivToday();
  const visitLabels = ctx.meetings.map((meeting) => visitLabelForMeeting(meeting, today));
  return block(CONTEXT_TAGS.meetings, { visitLabels });
};

/** Booking: full meetings with precomputed visitLabel. */
export const formatBookingMeetingsContext = (
  ctx: BookingContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  const today = kyivToday();
  // visitLabel is precomputed so the model quotes it instead of inventing a service or date.
  const meetings = ctx.meetings.map((meeting) => ({
    id: meeting.id,
    name: meeting.name,
    dateStart: meeting.dateStart,
    dateEnd: meeting.dateEnd,
    visitLabel: visitLabelForMeeting(meeting, today),
  }));
  const moveHint =
    meetings.length > 0
      ? "\nWhen moving or cancelling, quote visitLabel from this block only — never a procedure from earlier chat."
      : "";
  return block(CONTEXT_TAGS.meetings, { meetings, dateFrom: ctx.dateFrom }, moveHint);
};

/** Booking: full CRM contact record (never leaks internal error strings). */
export const formatContactContext = (
  ctx: ContactLookupContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  const payload = {
    contacts: ctx.contacts,
    ...(ctx.error ? { lookupFailed: true } : {}),
  };
  return block(CONTEXT_TAGS.contact, payload);
};

/** Supervisor: firstName only for the greeting. */
export const formatGreetingContact = (
  ctx: ContactLookupContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  const firstName = ctx.contacts[0]?.firstName;
  const payload = {
    firstName:
      typeof firstName === "string" && firstName.trim().length > 0 ? firstName.trim() : null,
  };
  return block(CONTEXT_TAGS.contact, payload);
};

export const formatAvailabilityContext = (
  ctx: AvailabilityContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  return block(CONTEXT_TAGS.availability, ctx);
};

export const formatServicesContext = (
  ctx: ServicesContext | null | undefined,
): string => {
  if (!ctx) {
    return "";
  }
  return block(CONTEXT_TAGS.services, ctx);
};

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

const listedVisitLines = (ctx: BookingContext, today = kyivToday()): string[] =>
  ctx.meetings.map((meeting) => `🗓️ ${visitLabelForMeeting(meeting, today)}`);

const visitListBlock = (ctx: BookingContext): string =>
  `Заплановані візити:\n${listedVisitLines(ctx).join("\n")}`;

/** Patient-facing «Мій запис» body from prefetch (not the supervisor LLM). */
export const formatMyVisitReply = (ctx: BookingContext): string => {
  const question =
    ctx.meetings.length > 1
      ? "Бажаєте перенести або скасувати якийсь із цих візитів?"
      : "Бажаєте перенести або скасувати цей візит?";
  return `${visitListBlock(ctx)}\n\n${question}`;
};

const VISIT_LIST_BLOCK =
  /(?:Заплановані візити|Planned visits):\s*\n(?:[ \t]*🗓️[^\n]*\n?)*/u;

const HELP_TAIL = /\n*(?:Чим можу допомогти\??|How can I help\??)\s*$/i;

const stripVisitList = (text: string): string =>
  text.replace(VISIT_LIST_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();

const injectVisitList = (text: string, ctx: BookingContext): string => {
  const cleaned = stripVisitList(text);
  const block = visitListBlock(ctx);
  const help = HELP_TAIL.exec(cleaned);
  if (help && help.index != null) {
    const head = cleaned.slice(0, help.index).trimEnd();
    return `${head}\n\n${block}\n\n${help[0].trim()}`;
  }
  return `${cleaned}\n\n${block}`;
};

export type FinishVisitIntent = "visit_ask" | "greeting" | "other";

/** Code-owned visit list on FINISH: visit-ask replaces the body; greeting injects prefetch lines; other only strips a model list. */
export const attachPrefetchVisits = (
  text: string,
  ctx: BookingContext | null | undefined,
  intent: FinishVisitIntent,
): string => {
  if (intent === "visit_ask") {
    if (!ctx || ctx.meetings.length === 0) {
      return text;
    }
    return formatMyVisitReply(ctx);
  }
  if (intent === "greeting" && ctx && ctx.meetings.length > 0) {
    return injectVisitList(text, ctx);
  }
  return stripVisitList(text);
};

// Uncached dynamic LLM blocks (Gemini 3 drops synthetic functionCall parts without thoughtSignature).

const block = (tag: string, payload: unknown, trailer = ""): string =>
  `<${tag}>\n${JSON.stringify(payload)}${trailer}\n</${tag}>`;

/** FAQ and supervisor: whether visits exist (same tag as booking meetings; projection differs). */
export const formatPlannedVisitsFlag = (
  ctx: BookingContext | null | undefined,
): string => {
  const has = (ctx?.meetings.length ?? 0) > 0;
  return block(CONTEXT_TAGS.meetings, { visits: has ? "has" : "none" });
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

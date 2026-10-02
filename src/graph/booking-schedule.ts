import {
  availabilityQueryFromContext,
  availabilityQueryFromCursor,
  type AvailabilityContext,
  type AvailabilityCursor,
} from "../tools/availability-tools.js";
import {
  resolveBookingScheduleRequest as resolveBaseScheduleRequest,
  type BookingScheduleRequest,
} from "../shared/booking-schedule.js";
import type { BookingDraft } from "./booking-draft.js";
import type { SelectedBookingSlot } from "./types.js";

export type BookingScheduleContext = {
  availabilityContext?: AvailabilityContext | null;
  availabilityCursor?: AvailabilityCursor | null;
  selectedDate?: string | null | undefined;
};

const dateWithAnchoredMonth = (anchor: string, day: number): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || day < 1 || day > 31) {
    return null;
  }
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
};

const resolveAnchoredBareDay = (
  text: string,
  today: string,
  context: BookingScheduleContext,
): string | null => {
  const match = /^(\d{1,2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const selectedDate = context.selectedDate ?? null;
  const selectedDay = selectedDate == null
    ? undefined
    : context.availabilityContext?.days.find((candidate) => candidate.date === selectedDate);
  if (day <= 23 && selectedDay && selectedDay.slots.length > 0) {
    return null;
  }
  const offered = context.availabilityContext?.days
    .filter((candidate) => candidate.slots.length > 0)
    .filter((candidate) => Number(candidate.date.slice(8, 10)) === day) ?? [];
  if (offered.length === 1) {
    return offered[0]!.date;
  }
  const contextQuery = availabilityQueryFromContext(context.availabilityContext);
  const cursorQuery = availabilityQueryFromCursor(context.availabilityCursor);
  const anchors = [
    selectedDate,
    contextQuery?.date,
    contextQuery?.anchor,
    contextQuery?.rangeThrough,
    contextQuery?.rangeFrom,
    cursorQuery?.date,
    cursorQuery?.anchor,
    cursorQuery?.rangeThrough,
    cursorQuery?.rangeFrom,
    context.availabilityCursor?.lastDate,
    context.availabilityCursor?.firstDate,
  ].filter((value): value is string => typeof value === "string");
  for (const anchor of anchors) {
    const candidate = dateWithAnchoredMonth(anchor, day);
    if (candidate && candidate >= today) {
      return candidate;
    }
  }
  return null;
};

/** Resolve one user message with the current calendar snapshot as ambiguity context. */
export const resolveBookingScheduleRequest = (
  text: string,
  today: string,
  context: BookingScheduleContext = {},
): BookingScheduleRequest | null =>
  resolveBaseScheduleRequest(text, today)
  ?? (() => {
    const date = resolveAnchoredBareDay(text, today, context);
    return date ? { kind: "exact" as const, date } : null;
  })();

const slotTime = (slot: SelectedBookingSlot): string => slot.dateStart.slice(11, 16);

export type RequestedTimeReconciliation =
  | { kind: "matched"; slot: SelectedBookingSlot }
  | { kind: "unavailable"; requestedTime: string }
  | { kind: "not_applicable" };

/** Reconcile patient time intent only against a fresh exact-date CRM snapshot. */
export const reconcileRequestedTime = (
  draft: BookingDraft | null | undefined,
  availability: AvailabilityContext | null | undefined,
): RequestedTimeReconciliation => {
  const requested = draft?.requestedTime;
  const selectedDate = draft?.selectedDate;
  if (!draft || requested?.status !== "pending" || selectedDate == null || availability == null) {
    return { kind: "not_applicable" };
  }
  const query = availabilityQueryFromContext(availability);
  if (query?.kind !== "exact" || query.date !== selectedDate) {
    return { kind: "not_applicable" };
  }
  if (
    draft.mode === "reschedule"
    && (!draft.rescheduleTarget
      || !availability.excludeMeetingIds?.includes(draft.rescheduleTarget.id))
  ) {
    return { kind: "not_applicable" };
  }
  const day = availability.days.find((candidate) => candidate.date === selectedDate);
  const slot = day?.slots.find((candidate) => slotTime(candidate) === requested.value);
  if (slot) {
    return {
      kind: "matched",
      slot: {
        slotId: slot.id,
        dateStart: slot.dateStart,
        dateEnd: slot.dateEnd,
        label: slot.label,
      },
    };
  }
  return { kind: "unavailable", requestedTime: requested.value };
};

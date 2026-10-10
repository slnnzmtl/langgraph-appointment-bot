import { CANCEL_CONFIRMATION_UK } from "../shared/clinic-constants.js";
import { normalizeLocalIsoDatetime } from "../tools/availability-slots.js";
import type { PendingBookingCommand } from "./booking-draft.js";

export type CancelMeetingRef = {
  id: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

export const cancelConfirmationMessage = (): string => CANCEL_CONFIRMATION_UK;

/** Build a cancel command payload for one planned visit. */
export const cancelCommandFromMeeting = (
  meeting: CancelMeetingRef,
  extras: Record<string, unknown> = {},
): PendingBookingCommand => {
  const payload: Record<string, unknown> = {
    meetingId: meeting.id,
    confirmMessage: cancelConfirmationMessage(),
    ...(meeting.name ? { name: meeting.name } : {}),
    ...extras,
  };
  for (const [key, value] of [
    ["dateStart", meeting.dateStart],
    ["dateEnd", meeting.dateEnd],
  ] as const) {
    if (value == null) {
      continue;
    }
    try {
      payload[key] = normalizeLocalIsoDatetime(value);
    } catch {
      // Meeting id is authoritative; CRM can fill a malformed display date.
    }
  }
  return { action: "cancel", payload };
};

/**
 * Cancel the single planned visit when the list has exactly one meeting.
 * Used by supervisor seeding and booking command preparation.
 */
export const cancelCommandForSingleVisit = (
  bookingContext: { meetings: CancelMeetingRef[] } | null | undefined,
  extras: Record<string, unknown> = {},
): PendingBookingCommand | null => {
  if (bookingContext?.meetings.length !== 1) {
    return null;
  }
  const meeting = bookingContext.meetings[0];
  return meeting != null ? cancelCommandFromMeeting(meeting, extras) : null;
};

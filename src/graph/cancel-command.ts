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
 * Turn a stored cancel command into tool args. The awaitingConfirmation draft
 * freezes the CRM write (`{ meetingId, status: "Not Held" }`), which is not a
 * valid `cancel_meeting` call — it has no confirmMessage.
 */
export const cancelCommandFromStoredPayload = (
  payload: Record<string, unknown>,
  display: { name?: string; dateStart?: string; dateEnd?: string } = {},
): PendingBookingCommand | null => {
  const meetingId = payload.meetingId;
  if (typeof meetingId !== "string" || meetingId.trim().length === 0) {
    return null;
  }
  const name = typeof payload.name === "string" && payload.name.trim().length > 0
    ? payload.name
    : display.name;
  const dateStart = typeof payload.dateStart === "string" && payload.dateStart.length > 0
    ? payload.dateStart
    : display.dateStart;
  const dateEnd = typeof payload.dateEnd === "string" && payload.dateEnd.length > 0
    ? payload.dateEnd
    : display.dateEnd;
  return cancelCommandFromMeeting({
    id: meetingId.trim(),
    ...(name ? { name } : {}),
    ...(dateStart ? { dateStart } : {}),
    ...(dateEnd ? { dateEnd } : {}),
  });
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

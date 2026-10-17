import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  normalizePresentAvailabilityResult,
  type AvailabilityContext,
} from "../../../tools/availability-tools.js";
import type { ClinicState } from "../../state.js";
import { captureLatestToolContext, toolMessageName } from "./tape.js";
import { latestPendingConfirmationIndex } from "./mutation.js";

export const SLOT_SELECTION_REQUIRED_ERROR = "Availability slot selection required";

export const SELECTED_SLOT_NOT_AVAILABLE_ERROR = "Selected slot is no longer available";

export const RESCHEDULE_STATE_REQUIRED_ERROR = "Reschedule state required";

/**
 * True when present_availability_slots ran after the latest awaitingConfirmation
 * mutation (or anywhere on the tape when there is no pending confirmation).
 * Pre-HITL leftover slots must not block coerce or TIME overlay.
 */
export const availabilitySlotsRanThisTurn = (messages: BaseMessage[]): boolean => {
  const start = latestPendingConfirmationIndex(messages) + 1;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message instanceof ToolMessage
      && toolMessageName(message) === "present_availability_slots"
    ) {
      return true;
    }
  }
  return false;
};

export const captureAvailabilityFromMessages = (
  messages: BaseMessage[],
): AvailabilityContext | null | undefined =>
  captureLatestToolContext(messages, "present_availability_slots", normalizePresentAvailabilityResult);

export const bookingDateAnchors = (state: ClinicState): string[] => [
  ...(state.bookingDraft?.selectedDate ? [state.bookingDraft.selectedDate] : []),
  ...(state.bookingDraft?.selectedSlot
    ? [state.bookingDraft.selectedSlot.dateStart, state.bookingDraft.selectedSlot.dateEnd]
    : []),
  ...(state.availabilityContext?.days ?? []).map((day) => day.date),
  ...(state.availabilityCursor
    ? [
      state.availabilityCursor.firstDate,
      state.availabilityCursor.lastDate,
      state.availabilityCursor.query?.rangeFrom,
      state.availabilityCursor.query?.rangeThrough,
    ].filter((date): date is string => date != null)
    : []),
];

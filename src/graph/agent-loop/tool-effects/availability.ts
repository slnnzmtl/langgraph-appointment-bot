import type { BaseMessage } from "@langchain/core/messages";
import {
  availabilityCursorFromContext,
  type AvailabilityContext,
} from "../../../tools/availability-tools.js";
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
} from "../../booking-draft.js";
import { reconcileRequestedTime } from "../../booking-schedule.js";
import { reduceBookingSession } from "../../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { captureAvailabilityFromMessages } from "../protocol/index.js";

const capturedAvailabilityForDraft = (
  state: ClinicState,
  resultMessages: BaseMessage[],
): AvailabilityContext | null | undefined => {
  const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
  if (capturedAvailability === undefined) {
    return undefined;
  }
  const acceptedService = state.bookingDraft?.serviceAcceptance;
  return capturedAvailability != null
    && acceptedService?.status === "accepted"
    ? { ...capturedAvailability, serviceId: acceptedService.service.id }
    : capturedAvailability;
};

/**
 * Stamp availabilityContext/cursor for decide read models.
 * Booking ToolNode uses this only — never reduceBookingSession.
 */
export const captureAvailabilityReadModel = (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
}): ClinicStateUpdate => {
  const bookingAvailability = capturedAvailabilityForDraft(
    input.state,
    input.resultMessages,
  );
  if (bookingAvailability === undefined) {
    return {};
  }
  return {
    availabilityContext: bookingAvailability,
    availabilityCursor: availabilityCursorFromContext(bookingAvailability),
  };
};

/** FAQ path: capture plus session/draft reconciliation. */
export const projectAvailabilityEffects = (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
}): ClinicStateUpdate => {
  const { state, resultMessages } = input;
  const bookingAvailability = capturedAvailabilityForDraft(state, resultMessages);
  if (bookingAvailability === undefined) {
    return {};
  }
  const patch: ClinicStateUpdate = {
    availabilityContext: bookingAvailability,
    availabilityCursor: availabilityCursorFromContext(bookingAvailability),
  };

  const reconciliation = reconcileRequestedTime(state.bookingDraft, bookingAvailability);
  let bookingDraft = state.bookingDraft;
  let pendingInteraction = state.pendingInteraction ?? null;
  if (reconciliation.kind === "matched" && bookingDraft) {
    const session = reduceBookingSession(
      {
        bookingDraft,
        pendingInteraction,
      },
      { type: "slot_selected", slot: reconciliation.slot },
    );
    bookingDraft = session.bookingDraft ?? null;
    pendingInteraction = session.pendingInteraction;
    patch.bookingDraft = session.bookingDraft;
    patch.pendingInteraction = session.pendingInteraction;
  } else if (reconciliation.kind === "unavailable" && bookingDraft) {
    bookingDraft = reduceBookingDraft(bookingDraft, {
      type: "requested_time_unavailable",
    });
    patch.bookingDraft = bookingDraft;
  }
  const selectedDate = bookingDraft?.selectedDate;
  const selectedSlot = bookingDraft?.selectedSlot ?? null;
  const selectedDay = selectedDate == null
    ? undefined
    : bookingAvailability?.days.find((day) => day.date === selectedDate);
  // Absent day is treated like an empty day: leave date selection.
  const keepDate = selectedDay != null && selectedDay.slots.length > 0;
  const selectedSlotStillAvailable = availabilityMatchesBooking(
    bookingAvailability,
    bookingDraft,
  )
    && (selectedSlot == null
      || selectedDay?.slots.some((slot) =>
        slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
      ) === true);
  if (
    selectedDate != null
    && (
      bookingAvailability == null
      || !keepDate
      || !selectedSlotStillAvailable
    )
  ) {
    if (bookingDraft) {
      const session = reduceBookingSession(
        {
          bookingDraft,
          pendingInteraction,
        },
        {
          type: "draft_event",
          event: {
            type: "slot_invalidated",
            keepDate,
          },
        },
      );
      patch.bookingDraft = session.bookingDraft;
      patch.pendingInteraction = session.pendingInteraction;
    }
  }
  return patch;
};

import type { BaseMessage } from "@langchain/core/messages";
import { availabilityCursorFromContext } from "../../../tools/availability-tools.js";
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import { reconcileRequestedTime } from "../../booking-schedule.js";
import { reduceBookingSession } from "../../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { captureAvailabilityFromMessages } from "../protocol.js";

/**
 * Non-mutation path: capture availability from tool messages, reconcile
 * requested time, and invalidate day/slot when the offer no longer matches.
 */
export const applyAvailabilityToolEffects = (
  state: ClinicState,
  resultMessages: BaseMessage[],
  update: ClinicStateUpdate,
): void => {
  const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
  if (capturedAvailability === undefined) {
    return;
  }
  const acceptedService = state.bookingDraft?.serviceAcceptance;
  const bookingAvailability = capturedAvailability != null
    && acceptedService?.status === "accepted"
    ? { ...capturedAvailability, serviceId: acceptedService.service.id }
    : capturedAvailability;
  update.availabilityContext = bookingAvailability;
  update.availabilityCursor = availabilityCursorFromContext(bookingAvailability);
  const reconciliation = reconcileRequestedTime(state.bookingDraft, bookingAvailability);
  if (reconciliation.kind === "matched" && state.bookingDraft) {
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "slot_selected", slot: reconciliation.slot },
    );
    update.bookingDraft = session.bookingDraft;
    update.pendingInteraction = session.pendingInteraction;
  } else if (reconciliation.kind === "unavailable" && state.bookingDraft) {
    update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "requested_time_unavailable",
    });
  }
  const bookingDraft = (update.bookingDraft as BookingDraft | undefined) ?? state.bookingDraft;
  const selectedDate = bookingDraft?.selectedDate;
  const selectedSlot = bookingDraft?.selectedSlot ?? null;
  const selectedDay = selectedDate == null
    ? undefined
    : bookingAvailability?.days.find((day) => day.date === selectedDate);
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
      || selectedDay?.slots.length === 0
      || !selectedSlotStillAvailable
    )
  ) {
    if (bookingDraft) {
      const session = reduceBookingSession(
        {
          bookingDraft,
          pendingInteraction:
            (update.pendingInteraction as typeof state.pendingInteraction | undefined)
            ?? state.pendingInteraction
            ?? null,
        },
        {
          type: "draft_event",
          event: {
            type: "slot_invalidated",
            keepDate: selectedDay?.slots.length !== 0,
          },
        },
      );
      update.bookingDraft = session.bookingDraft;
      update.pendingInteraction = session.pendingInteraction;
    }
  }
};

import type { BaseMessage } from "@langchain/core/messages";
import { availabilityCursorFromContext } from "../../tools/availability-tools.js";
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
} from "../booking-draft.js";
import { reconcileRequestedTime } from "../booking-schedule.js";
import { reduceBookingSession } from "../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { captureAvailabilityFromMessages } from "./protocol.js";

/** Capture / reconcile availability when mutation did not clear it. */
export const projectAvailabilityEffects = (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
}): ClinicStateUpdate => {
  const { state, resultMessages } = input;
  const patch: ClinicStateUpdate = {};
  const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
  if (capturedAvailability === undefined) {
    return patch;
  }
  const acceptedService = state.bookingDraft?.serviceAcceptance;
  const bookingAvailability = capturedAvailability != null
    && acceptedService?.status === "accepted"
    ? { ...capturedAvailability, serviceId: acceptedService.service.id }
    : capturedAvailability;
  patch.availabilityContext = bookingAvailability;
  patch.availabilityCursor = availabilityCursorFromContext(bookingAvailability);
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
          pendingInteraction,
        },
        {
          type: "draft_event",
          event: {
            type: "slot_invalidated",
            keepDate: selectedDay?.slots.length !== 0,
          },
        },
      );
      patch.bookingDraft = session.bookingDraft;
      patch.pendingInteraction = session.pendingInteraction;
    }
  }
  return patch;
};

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";
import { MAIN_MENU_LABEL } from "../../shared/clinic-constants.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { kyivToday } from "../../tools/availability-slots.js";
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
} from "../booking-draft.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import {
  interpretInteractionReply,
  reduceBookingSession,
} from "../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  type BookingNoteStatus,
  type SelectedBookingSlot,
} from "../types.js";
import {
  matchAvailabilityDay,
  matchAvailabilitySlot,
} from "../booking-interaction-render.js";

const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

export const authoritativeSelectedSlot = (state: ClinicState): SelectedBookingSlot | null =>
  state.bookingDraft?.selectedSlot ?? null;

export const authoritativeNoteStatus = (state: ClinicState): BookingNoteStatus =>
  state.bookingDraft?.note.status ?? "unasked";

export const noteStepBlocksCreate = (status: BookingNoteStatus | null | undefined): boolean =>
  status !== "skipped" && status !== "answered";

/**
 * Advance / reset the note ladder from the latest human line before the booking LLM runs.
 * Always ask once after a time pick — even if they named a procedure earlier.
 */
export const advanceBookingNoteStep = (state: ClinicState): ClinicStateUpdate => {
  const human = lastHumanText(state.messages);
  if (!human || human === MAIN_MENU_LABEL) {
    return {};
  }
  const status = authoritativeNoteStatus(state);
  const availability = state.availabilityContext;
  const bareNumber = /^(\d{1,2})$/.exec(human.trim());
  const currentSelectedDate = state.bookingDraft?.selectedDate;
  const currentSelectedDay = currentSelectedDate == null
    ? undefined
    : availability?.days.find((day) => day.date === currentSelectedDate);
  const bareNumberIsTime = bareNumber != null
    && Number(bareNumber[1]) <= 23
    && currentSelectedDay != null
    && currentSelectedDay.slots.length > 0;
  const matchedDay = bareNumberIsTime
    ? null
    : matchAvailabilityDay(human, availability?.days ?? []);
  const explicitDate = resolveBookingScheduleRequest(human, kyivToday(), {
    availabilityContext: state.availabilityContext,
    availabilityCursor: state.availabilityCursor,
    selectedDate: state.bookingDraft?.selectedDate,
  });

  if (
    explicitDate?.kind === "exact"
    && explicitDate.date !== state.bookingDraft?.selectedDate
  ) {
    trackEvent("booking_date_selected", { date: explicitDate.date });
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "date_selected", date: explicitDate.date },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
      ...(session.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    };
  }

  if (matchedDay) {
    trackEvent("booking_date_selected", { date: matchedDay.date });
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "date_selected", date: matchedDay.date },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
      ...(session.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    };
  }

  if (state.bookingDraft?.requestedTime?.status === "pending") {
    return {};
  }

  const selectedDate = state.bookingDraft?.selectedDate
    ?? (authoritativeSelectedSlot(state)?.dateStart.slice(0, 10) || null);
  const matchedSlot = availabilityMatchesBooking(availability, state.bookingDraft)
    ? matchAvailabilitySlot(human, availability, selectedDate)
    : null;

  const sameSlot =
    matchedSlot != null
    && authoritativeSelectedSlot(state) != null
    && authoritativeSelectedSlot(state)!.dateStart === matchedSlot.dateStart;

  const reduceSlotSelection = (slot: SelectedBookingSlot): ClinicStateUpdate | null => {
    let draft = state.bookingDraft;
    if (draft == null) {
      return null;
    }
    if (draft.selectedDate == null) {
      draft = reduceBookingDraft(draft, {
        type: "date_selected",
        date: slot.dateStart.slice(0, 10),
      });
    }
    if (draft == null) {
      return null;
    }
    const session = reduceBookingSession(
      {
        bookingDraft: draft,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "slot_selected", slot },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
      ...(session.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    };
  };

  if (state.bookingDraft?.mode === "reschedule") {
    if (matchedSlot && !sameSlot) {
      trackEvent("booking_note_step", { phase: "reschedule_slot" });
      return reduceSlotSelection(matchedSlot) ?? {};
    }
    return {};
  }

  if (
    (authoritativeSelectedSlot(state) != null && status === "unasked")
    || status === "awaiting"
  ) {
    const skipMatch = interpretInteractionReply(state.pendingInteraction, human);
    if (skipMatch.kind === "choice" && skipMatch.choiceId === "skip") {
      trackEvent("booking_note_step", { phase: "skipped" });
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "note_skipped" },
      );
      return {
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      };
    }
    if (status === "awaiting" && sameSlot) {
      return {};
    }
    if (status === "awaiting" && matchedSlot) {
      trackEvent("booking_note_step", { phase: "awaiting" });
      return reduceSlotSelection(matchedSlot) ?? {};
    }
  }

  if (matchedSlot && (status === "unasked" || !sameSlot)) {
    trackEvent("booking_note_step", { phase: "awaiting" });
    return reduceSlotSelection(matchedSlot) ?? {};
  }

  return {};
};

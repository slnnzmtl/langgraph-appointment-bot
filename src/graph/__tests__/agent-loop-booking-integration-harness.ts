import type { AvailabilityContext } from "../../tools/availability-tools.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import type { BookingDraft } from "../booking-draft.js";
import type { ClinicState } from "../state.js";
import { type ClinicAgentDefinition } from "../types.js";

import {
  canonicalBookingDraft,
  clinicState,
} from "./agent-loop-fixtures.js";

/** Shared booking agent definition for DDD-267 integration suites. */
export const bookingIntegrationAgent: ClinicAgentDefinition = {
  id: "booking",
  name: "Booking",
  description: "Books appointments",
  systemPrompt: "book",
  maxSteps: 8,
};

/** Default two-slot day used by schedule / HITL / reschedule integration tests. */
export const bookingIntegrationSnapshot: AvailabilityContext = {
  days: [
    {
      date: "2026-09-10",
      dayLabel: "10 вересня (четвер)",
      slots: [
        {
          id: "a",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        },
        {
          id: "b",
          label: "15:00",
          dateStart: "2026-09-10T15:00:00",
          dateEnd: "2026-09-10T15:30:00",
        },
      ],
    },
  ],
  stepMinutes: 30,
  startIntervalMinutes: 30,
};

/** Availability coerce/finalize tests need an accepted create service. */
export const acceptedCreateDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft =>
  canonicalBookingDraft({
    phase: "date",
    selectedDate: null,
    selectedSlot: null,
    note: { status: "unasked" },
    contactId: null,
    serviceAcceptance: {
      status: "accepted",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    },
    ...overrides,
  });

export const availabilityClinicState = (overrides: Partial<ClinicState> = {}): ClinicState =>
  clinicState({
    bookingDraft: acceptedCreateDraft(),
    ...overrides,
  });

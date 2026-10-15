import { describe, expect, it } from "vitest";

import {
  availabilityMatchesBooking,
  bookingAvailabilityScope,
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../../graph/booking-draft.js";
import {
  CLINIC_SLOT_MINUTES,
  CONSULTATION_SERVICE_ID,
} from "../../shared/clinic-constants.js";
import { buildAvailabilitySlotsArgs } from "../availability-args.js";

describe("buildAvailabilitySlotsArgs", () => {
  it("always grounds availability duration and excludes in the booking scope", () => {
    const args = buildAvailabilitySlotsArgs({
      direction: "exact",
      date: "2026-10-09",
      scope: { durationMinutes: 60, excludeMeetingIds: ["meeting-1"] },
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({
      direction: "exact",
      date: "2026-10-09",
      durationMinutes: 60,
      excludeMeetingIds: ["meeting-1"],
    });
  });

  it("replaces invented duration and exclusions for consultation with no draft duration", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      accepted: true,
    });
    const scope = bookingAvailabilityScope(draft);
    expect(scope).toEqual({ serviceId: CONSULTATION_SERVICE_ID });

    const args = buildAvailabilitySlotsArgs({
      direction: "nearest",
      scope,
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({
      direction: "nearest",
      durationMinutes: CLINIC_SLOT_MINUTES,
    });
    expect(availabilityMatchesBooking(
      {
        stepMinutes: CLINIC_SLOT_MINUTES,
        serviceId: CONSULTATION_SERVICE_ID,
      },
      draft,
    )).toBe(true);
  });

  it("uses offeredDayDate when exact has no date", () => {
    const args = buildAvailabilitySlotsArgs({
      direction: "exact",
      offeredDayDate: "2026-10-20",
      availabilityPagedThisTurn: false,
      scope: { durationMinutes: 30 },
    });

    expect(args).toEqual({
      direction: "exact",
      date: "2026-10-20",
      durationMinutes: 30,
    });
  });
});

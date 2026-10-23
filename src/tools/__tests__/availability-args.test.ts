import { describe, expect, it } from "vitest";

import {
  availabilityMatchesBooking,
  bookingAvailabilityScope,
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../../graph/booking/booking-draft.js";
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

  it("grounds earlier beforeDate on the first offered snapshot day", () => {
    const args = buildAvailabilitySlotsArgs({
      direction: "earlier",
      availabilityContext: {
        days: [
          {
            date: "2026-10-22",
            dayLabel: "22 жовт",
            slots: [{
              id: "s1",
              label: "11:00",
              dateStart: "2026-10-22T11:00:00",
              dateEnd: "2026-10-22T11:30:00",
            }],
          },
          {
            date: "2026-10-23",
            dayLabel: "23 жовт",
            slots: [{
              id: "s2",
              label: "12:00",
              dateStart: "2026-10-23T12:00:00",
              dateEnd: "2026-10-23T12:30:00",
            }],
          },
          {
            date: "2026-10-24",
            dayLabel: "24 жовт",
            slots: [{
              id: "s3",
              label: "13:00",
              dateStart: "2026-10-24T13:00:00",
              dateEnd: "2026-10-24T13:30:00",
            }],
          },
        ],
        stepMinutes: 30,
      },
      scope: { durationMinutes: 30 },
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({
      direction: "earlier",
      beforeDate: "2026-10-22",
      durationMinutes: 30,
    });
  });

  it("grounds later afterDate on the last open snapshot day", () => {
    const args = buildAvailabilitySlotsArgs({
      direction: "later",
      availabilityContext: {
        days: [
          {
            date: "2026-10-22",
            slots: [{
              id: "s1",
              label: "11:00",
              dateStart: "2026-10-22T11:00:00",
              dateEnd: "2026-10-22T11:30:00",
            }],
          },
          {
            date: "2026-10-24",
            slots: [{
              id: "s2",
              label: "13:00",
              dateStart: "2026-10-24T13:00:00",
              dateEnd: "2026-10-24T13:30:00",
            }],
          },
        ],
        stepMinutes: 30,
      },
      scope: { durationMinutes: 30 },
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({
      direction: "later",
      afterDate: "2026-10-24",
      durationMinutes: 30,
    });
  });
});

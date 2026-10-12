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
import { normalizeAvailabilityToolArgs } from "../availability-args.js";

describe("normalizeAvailabilityToolArgs", () => {
  it("always grounds availability duration and excludes in the booking scope", () => {
    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "exact",
        date: "2026-10-09",
        durationMinutes: 30,
        excludeMeetingIds: ["other"],
      },
      runtimeRequest: { kind: "exact", date: "2026-10-09" },
      scope: { durationMinutes: 60, excludeMeetingIds: ["meeting-1"] },
      availabilityPagedThisTurn: false,
    });

    expect(args.durationMinutes).toBe(60);
    expect(args.excludeMeetingIds).toEqual(["meeting-1"]);
  });

  it("replaces model-invented duration and exclusions for consultation with no draft duration", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      accepted: true,
    });
    const scope = bookingAvailabilityScope(draft);
    expect(scope).toEqual({ serviceId: CONSULTATION_SERVICE_ID });

    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "nearest",
        durationMinutes: 60,
        excludeMeetingIds: ["unrelated"],
      },
      runtimeRequest: null,
      scope,
      availabilityPagedThisTurn: false,
    });

    expect(args.durationMinutes).toBe(CLINIC_SLOT_MINUTES);
    expect(args.excludeMeetingIds).toBeUndefined();
    expect(availabilityMatchesBooking(
      {
        stepMinutes: CLINIC_SLOT_MINUTES,
        serviceId: CONSULTATION_SERVICE_ID,
      },
      draft,
    )).toBe(true);
  });

  it("drops model exact-today when the patient named no date", () => {
    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "exact",
        date: "2026-10-08",
        durationMinutes: 30,
      },
      runtimeRequest: null,
      availabilityPagedThisTurn: false,
      availabilityContext: {
        days: [],
        searchDirection: "exact",
        searchAnchor: "2026-10-08",
        query: {
          kind: "exact",
          date: "2026-10-08",
          rangeFrom: "2026-10-08",
          rangeThrough: "2026-10-08",
          coverageComplete: true,
        },
      },
    });

    expect(args).toEqual({ direction: "nearest", durationMinutes: 30 });
  });

  it("rewrites model later bounds to nearest on a bare affirmative", () => {
    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "later",
        afterDate: "2026-10-08",
        durationMinutes: 30,
      },
      runtimeRequest: null,
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({ direction: "nearest", durationMinutes: 30 });
  });

  it("keeps exact on a matched snapshot day when the model also sent a date", () => {
    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "exact",
        date: "2026-10-08",
        durationMinutes: 30,
      },
      runtimeRequest: null,
      offeredDayDate: "2026-10-20",
      availabilityPagedThisTurn: false,
    });

    expect(args).toEqual({
      direction: "exact",
      date: "2026-10-20",
      durationMinutes: 30,
    });
  });
});

import { describe, expect, it } from "vitest";

import { normalizeAvailabilityToolArgs } from "../availability-args.js";

describe("normalizeAvailabilityToolArgs", () => {
  it("always grounds availability duration in the accepted service", () => {
    const args = normalizeAvailabilityToolArgs({
      args: {
        direction: "exact",
        date: "2026-10-09",
        durationMinutes: 30,
      },
      runtimeRequest: { kind: "exact", date: "2026-10-09" },
      serviceDurationMinutes: 60,
      availabilityPagedThisTurn: false,
    });

    expect(args.durationMinutes).toBe(60);
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

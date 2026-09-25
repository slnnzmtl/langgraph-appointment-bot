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
      humanText: "9 жовтня",
      serviceDurationMinutes: 60,
      pickedOfferedDay: false,
      consultationAccepted: false,
      availabilityPagedThisTurn: false,
    });

    expect(args.durationMinutes).toBe(60);
  });
});

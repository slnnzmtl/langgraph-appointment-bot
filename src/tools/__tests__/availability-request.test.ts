import { describe, expect, it } from "vitest";

import { resolveAvailabilityRequest } from "../availability-request.js";

describe("resolveAvailabilityRequest", () => {
  const today = "2026-09-24";

  it.each([
    ["20 жовтня", "2026-10-20"],
    ["20 октября", "2026-10-20"],
    ["October 20", "2026-10-20"],
    ["2026-10-20", "2026-10-20"],
    ["завтра о 12:30", "2026-09-25"],
    ["на завтра 12:30", "2026-09-25"],
  ])("resolves %s to %s", (text, date) => {
    expect(resolveAvailabilityRequest(text, today)).toMatchObject({
      kind: "exact",
      date,
    });
  });

  it("keeps a preferred time separate from the calendar date", () => {
    expect(resolveAvailabilityRequest("на завтра 12:30", today)).toEqual({
      kind: "exact",
      date: "2026-09-25",
      preferredTime: "12:30",
    });
  });

  it("rejects invalid and non-date text", () => {
    expect(resolveAvailabilityRequest("31 лютого", today)).toBeNull();
    expect(resolveAvailabilityRequest("другая дата", today)).toBeNull();
  });
});

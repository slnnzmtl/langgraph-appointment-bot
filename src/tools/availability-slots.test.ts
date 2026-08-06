import { describe, expect, it } from "vitest";

import {
  computeFreeSlots,
  extractMeetingsFromSearchResult,
  localIso,
} from "./availability-slots.js";

describe("computeFreeSlots", () => {
  it("returns open-hour candidates when no meetings", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      openHour: 9,
      closeHour: 11,
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
    expect(slots[0]).toMatchObject({
      id: "2026-08-10T0900",
      dateStart: localIso("2026-08-10", 9, 0),
      dateEnd: localIso("2026-08-10", 9, 30),
    });
  });

  it("drops slots overlapping Planned meetings", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [
        {
          status: "Planned",
          dateStart: localIso("2026-08-10", 9, 0),
          dateEnd: localIso("2026-08-10", 10, 0),
        },
      ],
      openHour: 9,
      closeHour: 11,
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["10:00", "10:30"]);
  });

  it("parses EspoCRM space-separated meeting datetimes", () => {
    const slots = computeFreeSlots({
      day: "2026-08-07",
      meetings: [
        {
          status: "Planned",
          dateStart: "2026-08-07 11:30:00",
          dateEnd: "2026-08-07 12:00:00",
        },
      ],
      openHour: 11,
      closeHour: 13,
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["11:00", "12:00", "12:30"]);
  });

  it("ignores Not Held meetings", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [
        {
          status: "Not Held",
          dateStart: localIso("2026-08-10", 9, 0),
          dateEnd: localIso("2026-08-10", 10, 0),
        },
      ],
      openHour: 9,
      closeHour: 10,
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30"]);
  });

  it("caps presented slots", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      openHour: 9,
      closeHour: 18,
      stepMinutes: 30,
      maxSlots: 3,
    });

    expect(slots).toHaveLength(3);
  });

  it("rejects invalid day", () => {
    expect(() => computeFreeSlots({ day: "08-10", meetings: [] })).toThrow(/YYYY-MM-DD/);
  });
});

describe("extractMeetingsFromSearchResult", () => {
  it("reads meetings array", () => {
    expect(
      extractMeetingsFromSearchResult({
        meetings: [
          { dateStart: "2026-08-10T09:00:00", dateEnd: "2026-08-10T09:30:00", status: "Planned" },
        ],
      }),
    ).toHaveLength(1);
  });

  it("reads list array", () => {
    expect(
      extractMeetingsFromSearchResult({
        list: [{ dateStart: "a", dateEnd: "b" }],
      }),
    ).toEqual([{ dateStart: "a", dateEnd: "b" }]);
  });
});

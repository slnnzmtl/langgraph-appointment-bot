import { describe, expect, it } from "vitest";

import {
  computeFreeSlots,
  extractMeetingsFromSearchResult,
  localIso,
  normalizeLocalIsoDatetime,
  resolveDayTimeRanges,
  type WorkingTimeCalendarLike,
} from "../availability-slots.js";

describe("normalizeLocalIsoDatetime", () => {
  it("converts EspoCRM space-separated wall times to ISO", () => {
    expect(normalizeLocalIsoDatetime("2026-08-07 09:00:00")).toBe("2026-08-07T09:00:00");
    expect(normalizeLocalIsoDatetime("2026-08-07 09:30:00")).toBe("2026-08-07T09:30:00");
  });

  it("keeps ISO datetimes and pads missing seconds", () => {
    expect(normalizeLocalIsoDatetime("2026-08-07T09:00:00")).toBe("2026-08-07T09:00:00");
    expect(normalizeLocalIsoDatetime("2026-08-07T09:00")).toBe("2026-08-07T09:00:00");
  });

  it("strips trailing offset or Z", () => {
    expect(normalizeLocalIsoDatetime("2026-08-07T09:00:00Z")).toBe("2026-08-07T09:00:00");
    expect(normalizeLocalIsoDatetime("2026-08-07T09:00:00+03:00")).toBe("2026-08-07T09:00:00");
  });
});

const sampleCalendar: WorkingTimeCalendarLike = {
  timeRanges: [["11:00", "15:00"]],
  weekdays: {
    "0": false,
    "1": true,
    "2": true,
    "3": true,
    "4": true,
    "5": true,
    "6": false,
  },
  weekdayTimeRanges: {
    "0": null,
    "1": null,
    "2": null,
    "3": null,
    "4": null,
    "5": null,
    "6": null,
  },
};

describe("resolveDayTimeRanges", () => {
  // 2026-08-10 is Monday (weekday 1), 2026-08-09 is Sunday (weekday 0)
  it("returns default timeRanges on an open weekday", () => {
    expect(resolveDayTimeRanges(sampleCalendar, "2026-08-10")).toEqual([["11:00", "15:00"]]);
  });

  it("returns empty on a closed weekday", () => {
    expect(resolveDayTimeRanges(sampleCalendar, "2026-08-09")).toEqual([]);
  });

  it("prefers weekdayTimeRanges when non-empty", () => {
    const calendar: WorkingTimeCalendarLike = {
      ...sampleCalendar,
      weekdayTimeRanges: {
        ...sampleCalendar.weekdayTimeRanges,
        "1": [["09:00", "12:00"], ["14:00", "18:00"]],
      },
    };
    expect(resolveDayTimeRanges(calendar, "2026-08-10")).toEqual([
      ["09:00", "12:00"],
      ["14:00", "18:00"],
    ]);
  });

  it("returns empty when calendar is null", () => {
    expect(resolveDayTimeRanges(null, "2026-08-10")).toEqual([]);
  });
});

describe("computeFreeSlots", () => {
  it("returns open-hour candidates when no meetings", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      timeRanges: [["09:00", "11:00"]],
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
    expect(slots[0]).toMatchObject({
      id: "2026-08-10T0900",
      dateStart: localIso("2026-08-10", 9, 0),
      dateEnd: localIso("2026-08-10", 9, 30),
    });
  });

  it("supports minute-precision range starts", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      timeRanges: [["11:00", "12:30"]],
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["11:00", "11:30", "12:00"]);
  });

  it("supports multiple ranges per day", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      timeRanges: [["09:00", "10:00"], ["14:00", "15:00"]],
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30", "14:00", "14:30"]);
  });

  it("returns empty for empty timeRanges (closed day)", () => {
    expect(
      computeFreeSlots({
        day: "2026-08-10",
        meetings: [],
        timeRanges: [],
      }),
    ).toEqual([]);
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
      timeRanges: [["09:00", "11:00"]],
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
      timeRanges: [["11:00", "13:00"]],
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
      timeRanges: [["09:00", "10:00"]],
      stepMinutes: 30,
    });

    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30"]);
  });

  it("caps presented slots", () => {
    const slots = computeFreeSlots({
      day: "2026-08-10",
      meetings: [],
      timeRanges: [["09:00", "18:00"]],
      stepMinutes: 30,
      maxSlots: 3,
    });

    expect(slots).toHaveLength(3);
  });

  it("rejects invalid day", () => {
    expect(() =>
      computeFreeSlots({ day: "08-10", meetings: [], timeRanges: [["09:00", "18:00"]] }),
    ).toThrow(/YYYY-MM-DD/);
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

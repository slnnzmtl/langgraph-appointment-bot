import { describe, expect, it } from "vitest";

import {
  addCalendarDays,
  computeFreeSlots,
  excludeMeetingsById,
  extractMeetingsFromSearchResult,
  filterSlotsAfterNow,
  findNextAvailableSlots,
  formatKyivLocalIso,
  localIso,
  normalizeLocalIsoDatetime,
  resolveDayTimeRanges,
  resolveWeekdayTimeRanges,
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

  it("closes an open weekday covered by Non-working reserved time", () => {
    expect(
      resolveDayTimeRanges(sampleCalendar, "2026-08-10", [
        { type: "Non-working", dateStart: "2026-08-10", dateEnd: "2026-08-10" },
      ]),
    ).toEqual([]);
  });

  it("uses Working reserved timeRanges even on a closed weekday", () => {
    expect(
      resolveDayTimeRanges(sampleCalendar, "2026-08-09", [
        {
          type: "Working",
          dateStart: "2026-08-09",
          dateEnd: "2026-08-09",
          timeRanges: [["10:00", "12:00"]],
        },
      ]),
    ).toEqual([["10:00", "12:00"]]);
  });

  it("uses calendar default hours when Working reserved time has empty timeRanges", () => {
    expect(
      resolveDayTimeRanges(sampleCalendar, "2026-08-09", [
        { type: "Working", dateStart: "2026-08-09", dateEnd: "2026-08-09", timeRanges: null },
      ]),
    ).toEqual([["11:00", "15:00"]]);
  });

  it("lets Non-working win over Working on the same day", () => {
    expect(
      resolveDayTimeRanges(sampleCalendar, "2026-08-10", [
        {
          type: "Working",
          dateStart: "2026-08-10",
          dateEnd: "2026-08-10",
          timeRanges: [["09:00", "12:00"]],
        },
        { type: "Non-working", dateStart: "2026-08-10", dateEnd: "2026-08-10" },
      ]),
    ).toEqual([]);
  });
});

describe("resolveWeekdayTimeRanges", () => {
  it("returns default timeRanges on an open weekday index", () => {
    expect(resolveWeekdayTimeRanges(sampleCalendar, "1")).toEqual([["11:00", "15:00"]]);
  });

  it("returns empty on a closed weekday index", () => {
    expect(resolveWeekdayTimeRanges(sampleCalendar, "0")).toEqual([]);
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

  it("treats EspoCRM 24:00:00 as that calendar date, not the next midnight", () => {
    const slots = computeFreeSlots({
      day: "2026-08-27",
      meetings: [
        {
          dateStart: "2026-08-27 24:00:00",
          dateEnd: "2026-09-02 24:00:00",
        },
      ],
      timeRanges: [["11:00", "15:00"]],
      stepMinutes: 30,
    });
    expect(slots).toEqual([]);
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

  it("preserves meeting id when present", () => {
    expect(
      extractMeetingsFromSearchResult({
        meetings: [
          {
            id: "mtg-1",
            dateStart: "2026-08-10T09:00:00",
            dateEnd: "2026-08-10T09:30:00",
            status: "Planned",
          },
        ],
      }),
    ).toEqual([
      {
        id: "mtg-1",
        dateStart: "2026-08-10T09:00:00",
        dateEnd: "2026-08-10T09:30:00",
        status: "Planned",
      },
    ]);
  });
});

describe("excludeMeetingsById", () => {
  it("drops meetings whose id is listed", () => {
    expect(
      excludeMeetingsById(
        [
          { id: "a", dateStart: "1", dateEnd: "2" },
          { id: "b", dateStart: "3", dateEnd: "4" },
          { dateStart: "5", dateEnd: "6" },
        ],
        ["a"],
      ),
    ).toEqual([
      { id: "b", dateStart: "3", dateEnd: "4" },
      { dateStart: "5", dateEnd: "6" },
    ]);
  });
});

describe("addCalendarDays", () => {
  it("shifts across month boundaries", () => {
    expect(addCalendarDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addCalendarDays("2026-08-10", 0)).toBe("2026-08-10");
  });
});

describe("filterSlotsAfterNow", () => {
  it("keeps only slots after Kyiv wall-clock now", () => {
    const slots = [
      {
        id: "a",
        label: "10:00",
        dateStart: "2026-08-10T10:00:00",
        dateEnd: "2026-08-10T11:00:00",
      },
      {
        id: "b",
        label: "14:00",
        dateStart: "2026-08-10T14:00:00",
        dateEnd: "2026-08-10T15:00:00",
      },
    ];
    // 2026-08-10 12:00:00+03:00 Kyiv ≈ 09:00 UTC
    const now = new Date("2026-08-10T09:00:00Z");
    expect(formatKyivLocalIso(now).startsWith("2026-08-10T")).toBe(true);
    expect(filterSlotsAfterNow(slots, now).map((s) => s.label)).toEqual(["14:00"]);
  });
});

describe("findNextAvailableSlots", () => {
  const openWeekdays = {
    "0": false,
    "1": true,
    "2": true,
    "3": true,
    "4": true,
    "5": true,
    "6": false,
  };

  const calendar: WorkingTimeCalendarLike = {
    timeRanges: [["11:00", "15:00"]],
    weekdays: openWeekdays,
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

  const resolve = (day: string) => resolveDayTimeRanges(calendar, day);

  it("skips closed Sunday and finds Monday", () => {
    // 2026-08-09 is Sunday, 2026-08-10 Monday
    const result = findNextAvailableSlots({
      startDate: "2026-08-09",
      meetings: [],
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    expect(result.date).toBe("2026-08-10");
    expect(result.slots[0]?.label).toBe("11:00");
    expect(result.stepMinutes).toBe(60);
    expect(result.searchedDays).toBeGreaterThanOrEqual(2);
    expect(result.days[0]?.date).toBe("2026-08-10");
  });

  it("skips a full day and returns the next open day", () => {
    const meetings = [
      {
        status: "Planned",
        dateStart: "2026-08-10T11:00:00",
        dateEnd: "2026-08-10T15:00:00",
      },
    ];
    const result = findNextAvailableSlots({
      startDate: "2026-08-10",
      meetings,
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    expect(result.date).toBe("2026-08-11");
    expect(result.slots.some((s) => s.label === "11:00")).toBe(true);
    expect(result.days[0]?.date).toBe("2026-08-11");
  });

  it("uses 60-minute steps from durationMinutes", () => {
    const result = findNextAvailableSlots({
      startDate: "2026-08-10",
      meetings: [],
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    expect(result.slots.map((s) => s.label)).toEqual(["11:00", "12:00", "13:00", "14:00"]);
    expect(result.slots[0]?.dateEnd).toBe(localIso("2026-08-10", 12, 0));
  });

  it("filters past slots on Kyiv today then continues if none remain", () => {
    // Monday 2026-08-10 — after hours in Kyiv (18:00+03 ≈ 15:00Z)
    const now = new Date("2026-08-10T15:30:00Z");
    const result = findNextAvailableSlots({
      startDate: "2026-08-10",
      meetings: [],
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      now,
    });

    expect(result.date).toBe("2026-08-11");
    expect(result.slots[0]?.label).toBe("11:00");
  });

  it("blocks next-morning slots with overnight spanning meetings", () => {
    const meetings = [
      {
        status: "Planned",
        dateStart: "2026-08-10T14:00:00",
        dateEnd: "2026-08-11T12:00:00",
      },
    ];
    const result = findNextAvailableSlots({
      startDate: "2026-08-11",
      meetings,
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    expect(result.date).toBe("2026-08-11");
    expect(result.slots.map((s) => s.label)).toEqual(["12:00", "13:00", "14:00"]);
  });

  it("returns empty when no slots in horizon", () => {
    const alwaysClosed = (): [] => [];
    const result = findNextAvailableSlots({
      startDate: "2026-08-10",
      meetings: [],
      resolveTimeRanges: alwaysClosed,
      maxDays: 3,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    expect(result.slots).toEqual([]);
    expect(result.days).toEqual([]);
    expect(result.date).toBeUndefined();
    expect(result.searchedDays).toBe(3);
  });

  it("collects multiple open days with free slots", () => {
    const result = findNextAvailableSlots({
      startDate: "2026-08-10",
      meetings: [],
      resolveTimeRanges: resolve,
      durationMinutes: 60,
      maxDaysWithSlots: 3,
      now: new Date("2026-08-01T10:00:00Z"),
    });

    // Mon 10, Tue 11, Wed 12 (Thu 13 would be 4th)
    expect(result.days.map((d) => d.date)).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
    expect(result.date).toBe("2026-08-10");
    expect(result.slots).toEqual(result.days[0]?.slots);
  });
});

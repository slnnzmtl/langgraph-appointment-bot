import { beforeEach, describe, expect, it } from "vitest";

import {
  createPresentAvailabilitySlotsTool,
  resolveNextAvailableStart,
} from "../availability-tools.js";

type CallRecord = { name: string; args: Record<string, unknown> };

describe("meeting-tools availability", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const crmCalendar = {
    success: true,
    calendars: [
      {
        name: "Main",
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
      },
    ],
    ranges: [],
  };

  const presentAvailability = (callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) =>
    createPresentAvailabilitySlotsTool({
      callTool,
      assignedUserId: "user-1",
    });

  it("present_availability_slots uses CRM working hours", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              status: "Planned",
              dateStart: "2026-08-10T11:00:00",
              dateEnd: "2026-08-10T11:30:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const raw = await tool.invoke({ date: "2026-08-10" });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };

    expect(calls.some((c) => c.name === "get_working_time")).toBe(true);
    expect(calls.some((c) => c.name === "search_meetings")).toBe(true);
    expect(
      calls.find((c) => c.name === "get_working_time")?.args,
    ).toEqual({ userId: "user-1" });
    expect(calls.find((c) => c.name === "search_entity")?.args).toEqual({
      entityType: "CReservedTime",
      filters: {
        assignedUserId: "user-1",
        dateStart: { $lte: "2026-08-10T23:59:59" },
        dateEnd: { $gte: "2026-08-10T00:00:00" },
      },
      select: ["id", "dateStart", "dateEnd"],
      limit: 200,
    });
    expect(parsed.slots[0]?.label).toBe("11:30");
    expect(parsed.slots.some((s) => s.label === "09:00")).toBe(false);
    expect(parsed.slots.some((s) => s.label === "14:30")).toBe(true);
  });

  it("present_availability_slots applies Non-working reserved time from get_working_time ranges", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return {
          ...crmCalendar,
          ranges: [
            {
              type: "Non-working",
              dateStart: "2026-08-10",
              dateEnd: "2026-08-10",
            },
          ],
        };
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const raw = await tool.invoke({ date: "2026-08-10" });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };
    expect(parsed.slots).toEqual([]);
  });

  it("present_availability_slots uses Working reserved hours on a closed weekday", async () => {
    const callTool = async (name: string) => {
      if (name === "get_working_time") {
        return {
          ...crmCalendar,
          ranges: [
            {
              type: "Working",
              dateStart: "2026-08-09",
              dateEnd: "2026-08-09",
              timeRanges: [["10:00", "11:00"]],
            },
          ],
        };
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const raw = await tool.invoke({ date: "2026-08-09", durationMinutes: 30 });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };
    expect(parsed.slots.map((s) => s.label)).toEqual(["10:00", "10:30"]);
  });

  it("present_availability_slots falls back to clinic constants when get_working_time fails", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        throw new Error("CRM calendar missing");
      }
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              status: "Planned",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T09:30:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const raw = await tool.invoke({ date: "2026-08-10" });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };
    expect(parsed.slots[0]?.label).not.toBe("09:00");
    expect(parsed.slots.some((s) => s.label === "09:30")).toBe(true);
  });

  it("present_availability_slots without date uses ranged search_meetings", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              status: "Planned",
              dateStart: "2026-08-10T11:00:00",
              dateEnd: "2026-08-10T15:00:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const raw = await tool.invoke({
      startDate: "2026-08-10",
      durationMinutes: 60,
    });
    const parsed = JSON.parse(raw as string) as {
      date?: string;
      slots: Array<{ label: string }>;
      days?: Array<{ date: string; slots: Array<{ label: string }> }>;
      searchedDays?: number;
      stepMinutes: number;
    };

    const search = calls.find((c) => c.name === "search_meetings");
    expect(search?.args.dateFrom).toBe("2026-08-10");
    expect(search?.args.dateTo).toBe("2026-09-08");
    expect(search?.args.limit).toBe(200);
    expect(calls.find((c) => c.name === "search_entity")?.args).toEqual({
      entityType: "CReservedTime",
      filters: {
        assignedUserId: "user-1",
        dateStart: { $lte: "2026-09-08T23:59:59" },
        dateEnd: { $gte: "2026-08-10T00:00:00" },
      },
      select: ["id", "dateStart", "dateEnd"],
      limit: 200,
    });
    expect(parsed.date).toBe("2026-08-11");
    expect(parsed.stepMinutes).toBe(60);
    expect(parsed.slots[0]?.label).toBe("11:00");
    expect(parsed.days?.length).toBeGreaterThanOrEqual(2);
    expect(parsed.days?.[0]?.date).toBe("2026-08-11");
  });

  it("present_availability_slots dated path still uses single-day search", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    await tool.invoke({ date: "2026-08-10", durationMinutes: 30 });
    const search = calls.find((c) => c.name === "search_meetings");
    expect(search?.args).toMatchObject({
      dateFrom: "2026-08-10",
      dateTo: "2026-08-10",
      limit: 100,
    });
  });

  it("present_availability_slots afterDate skips the rejected day", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    // afterDate 2026-08-10 (Mon) → start 2026-08-11 (Tue); calendar open Mon–Fri 11–15.
    // Pin startDate so the window is not clamped to Kyiv today.
    const raw = await tool.invoke({
      afterDate: "2026-08-10",
      startDate: "2026-08-10",
      durationMinutes: 60,
    });
    const parsed = JSON.parse(raw as string) as {
      date?: string;
      slots: Array<{ label: string }>;
    };

    const search = calls.find((c) => c.name === "search_meetings");
    expect(search?.args.dateFrom).toBe("2026-08-11");
    expect(search?.args.dateTo).toBe("2026-09-09");
    expect(parsed.date).toBe("2026-08-11");
    expect(parsed.slots[0]?.label).toBe("11:00");
  });

  it("present_availability_slots afterDate returns later batch not the rejected day", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    const first = JSON.parse(
      (await tool.invoke({ startDate: "2026-08-10", durationMinutes: 60 })) as string,
    ) as { days: Array<{ date: string }> };
    expect(first.days[0]?.date).toBe("2026-08-10");

    calls.length = 0;
    const lastProposed = first.days[first.days.length - 1]?.date;
    const second = JSON.parse(
      (await tool.invoke({
        afterDate: lastProposed,
        durationMinutes: 60,
      })) as string,
    ) as { days: Array<{ date: string }>; date?: string };

    expect(second.days.every((d) => d.date > (lastProposed ?? ""))).toBe(true);
    expect(second.date).not.toBe("2026-08-10");
  });

  it("present_availability_slots uses the later of afterDate+1 and startDate", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_working_time") {
        return crmCalendar;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      return { ok: true };
    };

    const tool = presentAvailability(callTool);
    // afterDate → 2026-08-11; startDate 2026-08-12 is later
    const raw = await tool.invoke({
      afterDate: "2026-08-10",
      startDate: "2026-08-12",
      durationMinutes: 60,
    });
    const parsed = JSON.parse(raw as string) as { date?: string };

    const search = calls.find((c) => c.name === "search_meetings");
    expect(search?.args.dateFrom).toBe("2026-08-12");
    expect(parsed.date).toBe("2026-08-12");
  });
});

describe("resolveNextAvailableStart", () => {
  it("defaults to today", () => {
    expect(resolveNextAvailableStart({ today: "2026-08-10" })).toBe("2026-08-10");
  });

  it("advances past afterDate", () => {
    expect(
      resolveNextAvailableStart({ afterDate: "2026-08-10", today: "2026-08-01" }),
    ).toBe("2026-08-11");
  });

  it("picks the later of afterDate+1 and startDate", () => {
    expect(
      resolveNextAvailableStart({
        afterDate: "2026-08-10",
        startDate: "2026-08-12",
        today: "2026-08-01",
      }),
    ).toBe("2026-08-12");
    expect(
      resolveNextAvailableStart({
        afterDate: "2026-08-14",
        startDate: "2026-08-12",
        today: "2026-08-01",
      }),
    ).toBe("2026-08-15");
  });
});

describe("present_availability_slots excludeMeetingIds", () => {
  it("does not list the excluded meeting's current start, but frees later times in that block", async () => {
    const callTool = async (name: string) => {
      if (name === "get_working_time") {
        return {
          success: true,
          calendars: [
            {
              name: "Main",
              timeRanges: [["09:00", "10:00"]],
              weekdays: {
                "0": true,
                "1": true,
                "2": true,
                "3": true,
                "4": true,
                "5": true,
                "6": true,
              },
              weekdayTimeRanges: {},
            },
          ],
          ranges: [],
        };
      }
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              id: "mtg-busy",
              status: "Planned",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T10:00:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = createPresentAvailabilitySlotsTool({
      callTool,
      assignedUserId: "user-1",
    });

    const blocked = JSON.parse(
      (await tool.invoke({ date: "2026-08-10", durationMinutes: 30 })) as string,
    ) as { slots: Array<{ label: string }> };
    expect(blocked.slots.map((s) => s.label)).toEqual([]);

    const freed = JSON.parse(
      (await tool.invoke({
        date: "2026-08-10",
        durationMinutes: 30,
        excludeMeetingIds: ["mtg-busy"],
      })) as string,
    ) as { slots: Array<{ label: string }> };
    expect(freed.slots.map((s) => s.label)).toEqual(["09:30"]);
  });
});

describe("present_availability_slots CReservedTime", () => {
  const openMorning = {
    success: true,
    calendars: [
      {
        name: "Main",
        timeRanges: [["09:00", "10:00"]],
        weekdays: {
          "0": true,
          "1": true,
          "2": true,
          "3": true,
          "4": true,
          "5": true,
          "6": true,
        },
        weekdayTimeRanges: {},
      },
    ],
    ranges: [],
  };

  it("blocks slots overlapping CReservedTime even when search_meetings is empty", async () => {
    const callTool = async (name: string) => {
      if (name === "get_working_time") {
        return openMorning;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      if (name === "search_entity") {
        return {
          list: [
            {
              id: "rt-1",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T09:30:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = createPresentAvailabilitySlotsTool({
      callTool,
      assignedUserId: "user-1",
    });
    const parsed = JSON.parse(
      (await tool.invoke({ date: "2026-08-10", durationMinutes: 30 })) as string,
    ) as { slots: Array<{ label: string }> };

    expect(parsed.slots.some((s) => s.label === "09:00")).toBe(false);
    expect(parsed.slots.some((s) => s.label === "09:30")).toBe(true);
  });

  it("keeps CReservedTime busy when excludeMeetingIds frees a meeting", async () => {
    const callTool = async (name: string) => {
      if (name === "get_working_time") {
        return openMorning;
      }
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              id: "mtg-busy",
              status: "Planned",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T09:30:00",
            },
          ],
        };
      }
      if (name === "search_entity") {
        return {
          list: [
            {
              id: "rt-1",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T09:30:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const tool = createPresentAvailabilitySlotsTool({
      callTool,
      assignedUserId: "user-1",
    });
    const parsed = JSON.parse(
      (await tool.invoke({
        date: "2026-08-10",
        durationMinutes: 30,
        excludeMeetingIds: ["mtg-busy"],
      })) as string,
    ) as { slots: Array<{ label: string }> };

    expect(parsed.slots.some((s) => s.label === "09:00")).toBe(false);
  });

  it("still offers slots when search_entity CReservedTime fails", async () => {
    const callTool = async (name: string) => {
      if (name === "get_working_time") {
        return openMorning;
      }
      if (name === "search_meetings") {
        return { meetings: [] };
      }
      if (name === "search_entity") {
        throw new Error("CReservedTime missing");
      }
      return { ok: true };
    };

    const tool = createPresentAvailabilitySlotsTool({
      callTool,
      assignedUserId: "user-1",
    });
    const parsed = JSON.parse(
      (await tool.invoke({ date: "2026-08-10", durationMinutes: 30 })) as string,
    ) as { slots: Array<{ label: string }>; error?: string };

    expect(parsed.error).toBeUndefined();
    expect(parsed.slots.some((s) => s.label === "09:00")).toBe(true);
  });
});

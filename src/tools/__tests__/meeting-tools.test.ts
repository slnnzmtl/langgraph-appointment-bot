import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, beforeEach } from "vitest";

import { createMeetingTools, resolveNextAvailableStart } from "../meeting-tools.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const InterruptState = Annotation.Root({
  result: Annotation<string>,
});

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    const raw = await tool!.invoke({ date: "2026-08-10" });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };

    expect(calls.some((c) => c.name === "get_working_time")).toBe(true);
    expect(calls.some((c) => c.name === "search_meetings")).toBe(true);
    expect(
      calls.find((c) => c.name === "get_working_time")?.args,
    ).toEqual({ userId: "user-1" });
    expect(parsed.slots[0]?.label).toBe("11:30");
    expect(parsed.slots.some((s) => s.label === "09:00")).toBe(false);
    expect(parsed.slots.some((s) => s.label === "14:30")).toBe(true);
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    const raw = await tool!.invoke({ date: "2026-08-10" });
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    const raw = await tool!.invoke({
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    await tool!.invoke({ date: "2026-08-10", durationMinutes: 30 });
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    // afterDate 2026-08-10 (Mon) → start 2026-08-11 (Tue); calendar open Mon–Fri 11–15
    const raw = await tool!.invoke({
      afterDate: "2026-08-10",
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    const first = JSON.parse(
      (await tool!.invoke({ startDate: "2026-08-10", durationMinutes: 60 })) as string,
    ) as { days: Array<{ date: string }> };
    expect(first.days[0]?.date).toBe("2026-08-10");

    calls.length = 0;
    const lastProposed = first.days[first.days.length - 1]?.date;
    const second = JSON.parse(
      (await tool!.invoke({
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

    const [tool] = createMeetingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    // afterDate → 2026-08-11; startDate 2026-08-12 is later
    const raw = await tool!.invoke({
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

describe("create_meeting HITL interrupt", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { success: true, id: "meeting-1" };
  };

  const buildGraph = (dates?: { dateStart: string; dateEnd: string }) => {
    const [createMeeting] = createMeetingTools({
      callTool,
      assignedUserId: "assigned-99",
    }).filter((tool) => tool.name === "create_meeting");

    if (!createMeeting) {
      throw new Error("create_meeting tool missing");
    }

    return new StateGraph(InterruptState)
      .addNode("book", async () => {
        const result = await createMeeting.invoke({
          name: "Consult",
          dateStart: dates?.dateStart ?? "2026-08-07T10:00:00",
          dateEnd: dates?.dateEnd ?? "2026-08-07T10:30:00",
          contactId: "contact-1",
          serviceId: "svc-1",
          confirmMessage: "Confirm this booking?",
        });
        return { result: String(result) };
      })
      .addEdge(START, "book")
      .addEdge("book", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  it("resume confirmed:false skips MCP create_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-cancel" } };

      const first = await graph.invoke({ result: "" }, config);
      expect(first.__interrupt__).toBeDefined();
      expect(calls).toHaveLength(0);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: false } }),
        config,
      );
      expect(calls).toHaveLength(0);
      expect(JSON.parse(second.result)).toMatchObject({ cancelled: true });
    });
  });

  it("resume confirmed:true calls create_meeting once with required fields", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-confirm" } };

      await graph.invoke({ result: "" }, config);
      expect(calls).toHaveLength(0);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: true } }),
        config,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("create_meeting");
      expect(calls[0]?.args).toMatchObject({
        name: "Consult",
        dateStart: "2026-08-07T10:00:00",
        dateEnd: "2026-08-07T10:30:00",
        assignedUserId: "assigned-99",
        parentType: "Contact",
        parentId: "contact-1",
        contactsIds: ["contact-1"],
        cServicesIds: ["svc-1"],
        status: "Planned",
      });
      expect(JSON.parse(second.result)).toMatchObject({ success: true, id: "meeting-1" });
    });
  });

  it("normalizes space-separated datetimes before MCP create_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph({
        dateStart: "2026-08-07 09:00:00",
        dateEnd: "2026-08-07 09:30:00",
      });
      const config = { configurable: { thread_id: "hitl-normalize-dates" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { confirmed: true } }), config);

      expect(calls[0]?.args).toMatchObject({
        dateStart: "2026-08-07T09:00:00",
        dateEnd: "2026-08-07T09:30:00",
      });
    });
  });
});

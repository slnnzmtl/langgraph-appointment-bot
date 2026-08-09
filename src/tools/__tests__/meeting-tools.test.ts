import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, beforeEach } from "vitest";

import { createMeetingTools } from "../meeting-tools.js";
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMeetingTools } from "../meeting-tools.js";
import { lookupPlannedMeetings } from "../planned-meetings.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("list_planned_meetings", () => {
  beforeEach(() => {
    // 2026-08-23 14:00 Kyiv (UTC+3) ≈ 11:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T11:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls search_entity with Contact parent and Planned/Confirmed $in", async () => {
    await withTg(async () => {
      const calls: CallRecord[] = [];
      const callTool = async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_entity") {
          return {
            id: "contact-9",
            cTelegram: "tg-42",
            firstName: "Ada",
            lastName: "Lovelace",
            phoneNumber: "+380501112233",
          };
        }
        if (name === "search_contacts") {
          return {
            contacts: [{ id: "contact-9", cTelegram: "tg-42" }],
          };
        }
        return {
          success: true,
          list: [
            {
              id: "mtg-1",
              name: "Consult: Ada",
              dateStart: "2026-08-23T16:00:00",
              dateEnd: "2026-08-23T16:30:00",
              status: "Planned",
            },
          ],
        };
      };

      const [tool] = createMeetingTools({
        callTool,
        assignedUserId: "user-1",
      }).filter((t) => t.name === "list_planned_meetings");

      const raw = await tool!.invoke({ contactId: "contact-9", dateFrom: "2026-08-10" });
      const parsed = JSON.parse(raw as string) as {
        meetings: Array<{ id: string; name: string }>;
        dateFrom: string;
      };

      expect(calls.filter((c) => c.name === "search_entity")).toHaveLength(1);
      const search = calls.find((c) => c.name === "search_entity");
      expect(search?.args).toMatchObject({
        entityType: "Meeting",
        filters: {
          parentId: "contact-9",
          parentType: "Contact",
          status: { $in: ["Planned", "Confirmed"] },
          dateStart: { $gte: "2026-08-10T00:00:00" },
        },
        orderBy: "dateStart",
        order: "asc",
      });
      expect(parsed.dateFrom).toBe("2026-08-10");
      expect(parsed.meetings).toEqual([
        {
          id: "mtg-1",
          name: "Consult: Ada",
          dateStart: "2026-08-23T16:00:00",
          dateEnd: "2026-08-23T16:30:00",
        },
      ]);
    });
  });

  it("keeps Confirmed visits and drops Held / Not Held", async () => {
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "plan",
            name: "Later",
            dateStart: "2026-08-23T16:00:00",
            dateEnd: "2026-08-23T16:30:00",
            status: "Planned",
          },
          {
            id: "conf",
            name: "Consult: Ada",
            dateStart: "2026-08-23T18:05:00",
            dateEnd: "2026-08-23T18:35:00",
            status: "Confirmed",
          },
          {
            id: "held",
            name: "Done",
            dateStart: "2026-08-23T19:00:00",
            dateEnd: "2026-08-23T19:30:00",
            status: "Held",
          },
          {
            id: "cancelled",
            name: "Gone",
            dateStart: "2026-08-23T20:00:00",
            dateEnd: "2026-08-23T20:30:00",
            status: "Not Held",
          },
        ],
      }),
      "contact-9",
      "2026-08-23",
    );
    expect(listed?.meetings.map((m) => m.id)).toEqual(["plan", "conf"]);
  });

  it("lookupPlannedMeetings returns meetings payload and null on throw", async () => {
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "mtg-1",
            name: "Consult: Ada",
            dateStart: "2026-08-23T16:00:00",
            dateEnd: "2026-08-23T16:30:00",
          },
        ],
      }),
      "contact-9",
      "2026-08-10",
    );
    expect(listed).toEqual({
      meetings: [
        {
          id: "mtg-1",
          name: "Consult: Ada",
          dateStart: "2026-08-23T16:00:00",
          dateEnd: "2026-08-23T16:30:00",
        },
      ],
      dateFrom: "2026-08-10",
    });

    expect(
      await lookupPlannedMeetings(async () => {
        throw new Error("CRM down");
      }, "contact-9"),
    ).toBeNull();
  });

  it("drops a 16:45 Kyiv visit when now is 20:53 Kyiv", async () => {
    vi.setSystemTime(new Date("2026-08-23T17:53:00Z"));
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "past",
            name: "Consultation",
            dateStart: "2026-08-23 16:45:00",
            dateEnd: "2026-08-23 17:15:00",
          },
          {
            id: "future",
            name: "Later",
            dateStart: "2026-08-23T21:00:00",
            dateEnd: "2026-08-23T21:30:00",
          },
        ],
      }),
      "contact-9",
      "2026-08-23",
    );
    expect(listed?.meetings.map((m) => m.id)).toEqual(["future"]);
  });

  it("drops meetings whose dateStart is not after Kyiv now", async () => {
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "past",
            name: "Ended",
            dateStart: "2026-08-23T13:00:00",
            dateEnd: "2026-08-23T13:30:00",
          },
          {
            id: "future",
            name: "Later",
            dateStart: "2026-08-23T16:00:00",
            dateEnd: "2026-08-23T16:30:00",
          },
        ],
      }),
      "contact-9",
      "2026-08-23",
    );
    expect(listed?.meetings.map((m) => m.id)).toEqual(["future"]);
  });

  it("keeps meetings with unparseable dateStart", async () => {
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "bad",
            name: "Odd",
            dateStart: "not-a-datetime",
            dateEnd: "2026-08-23T16:30:00",
          },
        ],
      }),
      "contact-9",
      "2026-08-23",
    );
    expect(listed?.meetings).toEqual([
      {
        id: "bad",
        name: "Odd",
        dateStart: "not-a-datetime",
        dateEnd: "2026-08-23T16:30:00",
      },
    ]);
  });
});

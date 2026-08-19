import { describe, expect, it } from "vitest";

import { createMeetingTools } from "../meeting-tools.js";
import { lookupPlannedMeetings } from "../planned-meetings.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("list_planned_meetings", () => {
  it("calls search_entity with Contact parent and Planned filters", async () => {
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
              dateStart: "2026-08-12T10:00:00",
              dateEnd: "2026-08-12T10:30:00",
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

      expect(calls.some((c) => c.name === "search_entity")).toBe(true);
      const search = calls.find((c) => c.name === "search_entity");
      expect(search?.args).toMatchObject({
        entityType: "Meeting",
        filters: {
          parentId: "contact-9",
          parentType: "Contact",
          status: "Planned",
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
          dateStart: "2026-08-12T10:00:00",
          dateEnd: "2026-08-12T10:30:00",
        },
      ]);
    });
  });

  it("lookupPlannedMeetings returns meetings payload and null on throw", async () => {
    const listed = await lookupPlannedMeetings(
      async () => ({
        list: [
          {
            id: "mtg-1",
            name: "Consult: Ada",
            dateStart: "2026-08-12T10:00:00",
            dateEnd: "2026-08-12T10:30:00",
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
          dateStart: "2026-08-12T10:00:00",
          dateEnd: "2026-08-12T10:30:00",
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
});

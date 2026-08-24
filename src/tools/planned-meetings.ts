import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import type { McpCallTool } from "../shared/mcp.js";
import { formatKyivLocalIso, normalizeLocalIsoDatetime, kyivToday } from "./availability-slots.js";

const DAY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar day YYYY-MM-DD");

export type ListedMeeting = {
  id: string;
  name: string;
  dateStart: string;
  dateEnd: string;
};

export type BookingContext = {
  meetings: ListedMeeting[];
  dateFrom: string;
};

/** Compact planned meetings from search_entity Meeting list payloads. */
const extractPlannedMeetingsFromEntityResult = (raw: unknown): ListedMeeting[] => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const list = Array.isArray((value as { list?: unknown }).list)
    ? (value as { list: unknown[] }).list
    : Array.isArray((value as { meetings?: unknown }).meetings)
      ? (value as { meetings: unknown[] }).meetings
      : [];

  const out: ListedMeeting[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;
    if (
      typeof m.id !== "string"
      || typeof m.name !== "string"
      || typeof m.dateStart !== "string"
      || typeof m.dateEnd !== "string"
    ) {
      continue;
    }
    out.push({
      id: m.id,
      name: m.name,
      dateStart: m.dateStart,
      dateEnd: m.dateEnd,
    });
  }
  return out;
};

/** Keep meetings whose start is still after Kyiv now; keep unparseable dateStart. */
const filterUpcomingMeetings = (
  meetings: ListedMeeting[],
  now = new Date(),
): ListedMeeting[] => {
  const nowIso = formatKyivLocalIso(now);
  return meetings.filter((meeting) => {
    try {
      return normalizeLocalIsoDatetime(meeting.dateStart) > nowIso;
    } catch {
      return true;
    }
  });
};

export const lookupPlannedMeetings = async (
  callTool: McpCallTool,
  contactId: string,
  dateFrom?: string,
): Promise<BookingContext | null> => {
  try {
    const from = dateFrom ?? kyivToday();
    const raw = await callTool("search_entity", {
      entityType: "Meeting",
      filters: {
        parentId: contactId,
        parentType: "Contact",
        status: "Planned",
        dateStart: { $gte: `${from}T00:00:00` },
      },
      select: ["id", "name", "dateStart", "dateEnd", "status"],
      orderBy: "dateStart",
      order: "asc",
      limit: 50,
    });
    return {
      meetings: filterUpcomingMeetings(extractPlannedMeetingsFromEntityResult(raw)),
      dateFrom: from,
    };
  } catch {
    return null;
  }
};

export const createListPlannedMeetingsTool = (
  callTool: McpCallTool,
  requireOwnedContact: (contactId: string) => Promise<string | null>,
): StructuredToolInterface =>
  tool(
    async (input: { contactId: string; dateFrom?: string }) => {
      const denied = await requireOwnedContact(input.contactId);
      if (denied) {
        return denied;
      }
      const listed = await lookupPlannedMeetings(callTool, input.contactId, input.dateFrom);
      return JSON.stringify(listed ?? { error: "Unable to list planned meetings", meetings: [] });
    },
    {
      name: "list_planned_meetings",
      description:
        "List upcoming Planned meetings for a Contact (parentId). Use before cancel or reschedule, or when the user asks what is booked. Pass contactId from <contact_info> / create_contact / link_telegram_to_contact. Optional dateFrom defaults to Kyiv today. Returns { meetings: [{ id, name, dateStart, dateEnd }] }.",
      schema: z.object({
        contactId: z.string().min(1).describe("Patient Contact id"),
        dateFrom: DAY_SCHEMA.optional().describe(
          "First day to include (YYYY-MM-DD). Default: Kyiv today.",
        ),
      }),
    },
  );

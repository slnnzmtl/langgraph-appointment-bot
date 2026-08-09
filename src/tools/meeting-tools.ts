import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

import {
  CLINIC_SLOT_MINUTES,
  MAX_AVAILABILITY_SEARCH_DAYS,
} from "../shared/clinic-constants.js";
import type { McpCallTool } from "../shared/mcp.js";
import {
  addCalendarDays,
  computeFreeSlots,
  extractMeetingsFromSearchResult,
  fallbackClinicTimeRanges,
  findNextAvailableSlots,
  formatKyivLocalIso,
  normalizeLocalIsoDatetime,
  resolveDayTimeRanges,
  type TimeRangePair,
  type WorkingTimeCalendarLike,
} from "./availability-slots.js";
import { toToolResult } from "./tool-result.js";

export type MeetingToolsOptions = {
  callTool: McpCallTool;
  assignedUserId: string;
};

/** Phase 4 Telegram Yes/No callbacks resume with this shape (LangGraph skips falsy `resume`). */
export type BookingConfirmResume = { confirmed: boolean };

export const isBookingConfirmed = (decision: unknown): boolean =>
  typeof decision === "object"
  && decision !== null
  && "confirmed" in decision
  && (decision as BookingConfirmResume).confirmed === true;

const DAY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar day YYYY-MM-DD");

/** MCP search_meetings validates limit <= 200. */
const RANGED_MEETINGS_LIMIT = 200;

const parseWorkingTimeCalendars = (raw: unknown): WorkingTimeCalendarLike[] => {
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
  const calendars = (value as { calendars?: unknown }).calendars;
  return Array.isArray(calendars) ? (calendars as WorkingTimeCalendarLike[]) : [];
};

type WorkingCalendarFetch = {
  calendar: WorkingTimeCalendarLike | null;
  /** CRM missing/failed — open every day with clinic fallback hours. */
  useClinicFallback: boolean;
};

/** Fetch CRM working-time calendar once; preserve fallback vs closed-day semantics. */
const fetchWorkingCalendar = async (
  callTool: McpCallTool,
  assignedUserId: string,
): Promise<WorkingCalendarFetch> => {
  try {
    const raw = await callTool("get_working_time", { userId: assignedUserId });
    const calendar = parseWorkingTimeCalendars(raw)[0] ?? null;
    if (!calendar) {
      return { calendar: null, useClinicFallback: true };
    }
    return { calendar, useClinicFallback: false };
  } catch {
    return { calendar: null, useClinicFallback: true };
  }
};

const resolveRangesForDay = (
  fetch: WorkingCalendarFetch,
  day: string,
): TimeRangePair[] => {
  if (fetch.useClinicFallback) {
    return fallbackClinicTimeRanges();
  }
  return resolveDayTimeRanges(fetch.calendar, day);
};

/** Next-available search start: later of startDate and day after afterDate (YYYY-MM-DD compares lexicographically). */
export const resolveNextAvailableStart = (input: {
  startDate?: string;
  afterDate?: string;
  today: string;
}): string => {
  let start = input.startDate ?? input.today;
  if (input.afterDate) {
    const after = addCalendarDays(input.afterDate, 1);
    if (after > start) {
      start = after;
    }
  }
  return start;
};

export const createMeetingTools = (options: MeetingToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const presentAvailabilitySlots = tool(
    async (input: {
      date?: string;
      startDate?: string;
      afterDate?: string;
      durationMinutes?: number;
    }) => {
      try {
        const stepMinutes = input.durationMinutes ?? CLINIC_SLOT_MINUTES;

        if (input.date) {
          const [fetch, raw] = await Promise.all([
            fetchWorkingCalendar(callTool, assignedUserId),
            callTool("search_meetings", {
              dateFrom: input.date,
              dateTo: input.date,
              assignedUserId,
              limit: 100,
            }),
          ]);
          const meetings = extractMeetingsFromSearchResult(raw);
          const slots = computeFreeSlots({
            day: input.date,
            meetings,
            timeRanges: resolveRangesForDay(fetch, input.date),
            stepMinutes,
          });
          return JSON.stringify({ slots, date: input.date, stepMinutes });
        }

        const today = formatKyivLocalIso(new Date()).slice(0, 10);
        const start = resolveNextAvailableStart({
          ...(input.startDate ? { startDate: input.startDate } : {}),
          ...(input.afterDate ? { afterDate: input.afterDate } : {}),
          today,
        });
        const end = addCalendarDays(start, MAX_AVAILABILITY_SEARCH_DAYS - 1);
        const [fetch, raw] = await Promise.all([
          fetchWorkingCalendar(callTool, assignedUserId),
          callTool("search_meetings", {
            dateFrom: start,
            dateTo: end,
            assignedUserId,
            limit: RANGED_MEETINGS_LIMIT,
          }),
        ]);
        const meetings = extractMeetingsFromSearchResult(raw);
        const result = findNextAvailableSlots({
          startDate: start,
          meetings,
          durationMinutes: stepMinutes,
          resolveTimeRanges: (day) => resolveRangesForDay(fetch, day),
          now: new Date(),
        });
        return JSON.stringify({
          ...result,
          ...(meetings.length >= RANGED_MEETINGS_LIMIT ? { truncated: true } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message, slots: [] });
      }
    },
    {
      name: "present_availability_slots",
      description:
        "Compute free appointment slots from CRM meetings (search_meetings). Pass date for one day, or omit date to find the next open days with free slots (up to 5 days; optional startDate / afterDate). Use afterDate when the user wants other dates after a proposed day (коли ще / пошукай ще / another day) — set afterDate to the last proposed YYYY-MM-DD. Always pass durationMinutes from the matched service when known. Returns JSON { days: [{ date, slots }], date, slots, stepMinutes, searchedDays? }. Prefer days[]; date/slots mirror the first day. List every returned day and all slot labels — do not invent times or claim a day is the only option unless days is empty after afterDate.",
      schema: z.object({
        date: DAY_SCHEMA.optional().describe(
          "Specific calendar day YYYY-MM-DD. Omit to search for the next available days.",
        ),
        startDate: DAY_SCHEMA.optional().describe(
          "When date is omitted: first day of the next-available search (default Kyiv today).",
        ),
        afterDate: DAY_SCHEMA.optional().describe(
          "When date is omitted: skip this day and all earlier — search starts the next calendar day. Required when the user rejects a date or asks for other dates (коли ще / пошукай ще). If both afterDate and startDate are set, the later day wins.",
        ),
        durationMinutes: z
          .number()
          .int()
          .min(15)
          .max(180)
          .optional()
          .describe("Slot length in minutes from the service duration (default 30)"),
      }),
    },
  );

  const createMeeting = tool(
    async (input: {
      name: string;
      dateStart: string;
      dateEnd: string;
      contactId: string;
      confirmMessage: string;
      serviceId: string;
      description?: string;
      location?: string;
    }) => {
      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft = {
        name: input.name,
        dateStart,
        dateEnd,
        contactId: input.contactId,
        confirmMessage: input.confirmMessage.trim(),
        serviceId: input.serviceId,
        ...(input.description ? { description: input.description } : {}),
        ...(input.location ? { location: input.location } : {}),
      };

      const decision = interrupt({ type: "confirm_booking", draft });
      if (!isBookingConfirmed(decision)) {
        return JSON.stringify({ cancelled: true, message: "Booking cancelled by user." });
      }

      try {
        const result = await callTool("create_meeting", {
          name: input.name,
          dateStart,
          dateEnd,
          assignedUserId,
          parentType: "Contact",
          parentId: input.contactId,
          contactsIds: [input.contactId],
          cServicesIds: [input.serviceId],
          ...(input.description ? { description: input.description } : {}),
          ...(input.location ? { location: input.location } : {}),
          status: "Planned",
        });
        return toToolResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "create_meeting",
      description:
        "Book an appointment when contact, service, and start/end are known. Call immediately. Requires confirmMessage (patient language). Pauses for Yes/No before writing; injects assignedUserId and Contact parent fields.",
      schema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Meeting title as "[service-name]: [client-name]" (e.g. "Консультація: Daniel")'),
        dateStart: z.string().describe("Start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("End datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        contactId: z.string().min(1).describe("Patient Contact id"),
        confirmMessage: z
          .string()
          .min(1)
          .describe(
            "Short Yes/No question in the patient's chat language (e.g. Підтвердити запис?). Ignore supervisor prompt language.",
          ),
        serviceId: z.string().min(1).describe("Required cService entity id (resolve via list_services)"),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
    },
  );

  return [presentAvailabilitySlots, createMeeting];
};

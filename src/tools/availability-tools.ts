import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { trackEvent, trackToolError } from "../analytics/track.js";
import {
  CLINIC_SLOT_MINUTES,
  MAX_AVAILABILITY_SEARCH_DAYS,
} from "../shared/clinic-constants.js";
import { asJsonRecord, errorMessage } from "../shared/json-record.js";
import type { McpCallTool } from "../shared/mcp.js";
import {
  addCalendarDays,
  computeFreeSlots,
  excludeMeetingsById,
  extractMeetingsFromSearchResult,
  fallbackClinicTimeRanges,
  findNextAvailableSlots,
  formatKyivDayLabel,
  formatKyivLocalIso,
  omitSlotsAtStarts,
  resolveDayTimeRanges,
  startsOfExcludedMeetings,
  type AvailabilitySlot,
  type BusyMeeting,
  type TimeRangePair,
  type WorkingTimeCalendarLike,
  type WorkingTimeRangeLike,
} from "./availability-slots.js";

export type AvailabilityContext = {
  days: Array<{ date: string; dayLabel?: string; slots: AvailabilitySlot[] }>;
  stepMinutes: number;
  excludeMeetingIds?: string[];
  truncated?: boolean;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseAvailabilitySlot = (value: unknown): AvailabilitySlot | null => {
  const record = asJsonRecord(value);
  if (!record) {
    return null;
  }
  if (
    typeof record.label !== "string"
    || typeof record.dateStart !== "string"
    || typeof record.dateEnd !== "string"
  ) {
    return null;
  }
  return {
    id: typeof record.id === "string" ? record.id : record.dateStart,
    label: record.label,
    dateStart: record.dateStart,
    dateEnd: record.dateEnd,
  };
};

const parseAvailabilityDays = (
  value: unknown,
): Array<{ date: string; dayLabel?: string; slots: AvailabilitySlot[] }> => {
  if (!Array.isArray(value)) {
    return [];
  }
  const days: Array<{ date: string; dayLabel?: string; slots: AvailabilitySlot[] }> = [];
  for (const entry of value) {
    const record = asJsonRecord(entry);
    if (!record || typeof record.date !== "string" || !DAY_RE.test(record.date)) {
      continue;
    }
    const slots = Array.isArray(record.slots)
      ? record.slots.map(parseAvailabilitySlot).filter((slot): slot is AvailabilitySlot => slot != null)
      : [];
    days.push({
      date: record.date,
      ...(typeof record.dayLabel === "string" ? { dayLabel: record.dayLabel } : {}),
      slots,
    });
  }
  return days;
};

/** Normalize a successful present_availability_slots tool payload for checkpoint reuse. */
export const normalizePresentAvailabilityResult = (raw: string): AvailabilityContext | null => {
  const record = asJsonRecord(raw);
  if (!record || typeof record.error === "string") {
    return null;
  }

  const stepMinutes =
    typeof record.stepMinutes === "number" ? record.stepMinutes : CLINIC_SLOT_MINUTES;
  const truncated = record.truncated === true;
  const excludeMeetingIds = Array.isArray(record.excludeMeetingIds)
    ? record.excludeMeetingIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;

  if (Array.isArray(record.days)) {
    const days = parseAvailabilityDays(record.days);
    return {
      days,
      stepMinutes,
      ...(excludeMeetingIds && excludeMeetingIds.length > 0 ? { excludeMeetingIds } : {}),
      ...(truncated ? { truncated } : {}),
    };
  }

  if (typeof record.date === "string" && DAY_RE.test(record.date) && Array.isArray(record.slots)) {
    const slots = record.slots
      .map(parseAvailabilitySlot)
      .filter((slot): slot is AvailabilitySlot => slot != null);
    return {
      days: [
        {
          date: record.date,
          ...(typeof record.dayLabel === "string" ? { dayLabel: record.dayLabel } : {}),
          slots,
        },
      ],
      stepMinutes,
      ...(excludeMeetingIds && excludeMeetingIds.length > 0 ? { excludeMeetingIds } : {}),
    };
  }

  return null;
};

const DAY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar day YYYY-MM-DD");

/** MCP search_meetings validates limit <= 200. */
const RANGED_MEETINGS_LIMIT = 200;

const parseWorkingTimeResult = (
  raw: unknown,
): { calendars: WorkingTimeCalendarLike[]; ranges: WorkingTimeRangeLike[] } => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { calendars: [], ranges: [] };
    }
  }
  if (!value || typeof value !== "object") {
    return { calendars: [], ranges: [] };
  }
  const record = value as { calendars?: unknown; ranges?: unknown };
  return {
    calendars: Array.isArray(record.calendars)
      ? (record.calendars as WorkingTimeCalendarLike[])
      : [],
    ranges: Array.isArray(record.ranges) ? (record.ranges as WorkingTimeRangeLike[]) : [],
  };
};

type WorkingCalendarFetch = {
  calendar: WorkingTimeCalendarLike | null;
  ranges: WorkingTimeRangeLike[];
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
    const { calendars, ranges } = parseWorkingTimeResult(raw);
    const calendar = calendars[0] ?? null;
    if (!calendar) {
      return { calendar: null, ranges: [], useClinicFallback: true };
    }
    return { calendar, ranges, useClinicFallback: false };
  } catch {
    return { calendar: null, ranges: [], useClinicFallback: true };
  }
};

const resolveRangesForDay = (
  fetch: WorkingCalendarFetch,
  day: string,
): TimeRangePair[] => {
  if (fetch.useClinicFallback) {
    return fallbackClinicTimeRanges();
  }
  return resolveDayTimeRanges(fetch.calendar, day, fetch.ranges);
};

const searchReservedTimes = async (
  callTool: McpCallTool,
  assignedUserId: string,
  dateFrom: string,
  dateTo: string,
): Promise<BusyMeeting[]> => {
  try {
    const raw = await callTool("search_entity", {
      entityType: "CReservedTime",
      filters: {
        assignedUserId,
        dateStart: { $lte: `${dateTo}T23:59:59` },
        dateEnd: { $gte: `${dateFrom}T00:00:00` },
      },
      select: ["id", "dateStart", "dateEnd"],
      limit: RANGED_MEETINGS_LIMIT,
    });
    return extractMeetingsFromSearchResult(raw);
  } catch {
    return [];
  }
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

export const createPresentAvailabilitySlotsTool = (options: {
  callTool: McpCallTool;
  assignedUserId: string;
}): StructuredToolInterface => {
  const { callTool, assignedUserId } = options;

  return tool(
    async (input: {
      date?: string;
      startDate?: string;
      afterDate?: string;
      durationMinutes?: number;
      excludeMeetingIds?: string[];
    }) => {
      try {
        const stepMinutes = input.durationMinutes ?? CLINIC_SLOT_MINUTES;
        const excludeIds = input.excludeMeetingIds;
        const todayKyiv = formatKyivLocalIso(new Date()).slice(0, 10);

        if (input.date) {
          const [working, raw, reserved] = await Promise.all([
            fetchWorkingCalendar(callTool, assignedUserId),
            callTool("search_meetings", {
              dateFrom: input.date,
              dateTo: input.date,
              assignedUserId,
              limit: 100,
            }),
            searchReservedTimes(callTool, assignedUserId, input.date, input.date),
          ]);
          const searchedMeetings = extractMeetingsFromSearchResult(raw);
          const omitDateStarts = startsOfExcludedMeetings(searchedMeetings, excludeIds);
          const meetings = [
            ...excludeMeetingsById(searchedMeetings, excludeIds),
            ...reserved,
          ];
          const timeRanges = resolveRangesForDay(working, input.date);
          const slots = omitSlotsAtStarts(
            computeFreeSlots({
              day: input.date,
              meetings,
              timeRanges,
              stepMinutes,
            }),
            omitDateStarts,
          );
          trackEvent("availability_presented", {
            outcome: "success",
            date: input.date,
            slot_count: slots.length,
            duration_minutes: stepMinutes,
          });
          return JSON.stringify({
            slots,
            date: input.date,
            dayLabel: formatKyivDayLabel(input.date, todayKyiv),
            stepMinutes,
            ...(excludeIds?.length ? { excludeMeetingIds: excludeIds } : {}),
          });
        }

        const today = todayKyiv;
        const start = resolveNextAvailableStart({
          ...(input.startDate ? { startDate: input.startDate } : {}),
          ...(input.afterDate ? { afterDate: input.afterDate } : {}),
          today,
        });
        const end = addCalendarDays(start, MAX_AVAILABILITY_SEARCH_DAYS - 1);
        const [working, raw, reserved] = await Promise.all([
          fetchWorkingCalendar(callTool, assignedUserId),
          callTool("search_meetings", {
            dateFrom: start,
            dateTo: end,
            assignedUserId,
            limit: RANGED_MEETINGS_LIMIT,
          }),
          searchReservedTimes(callTool, assignedUserId, start, end),
        ]);
        const searchedMeetings = extractMeetingsFromSearchResult(raw);
        const omitDateStarts = startsOfExcludedMeetings(searchedMeetings, excludeIds);
        const meetings = [
          ...excludeMeetingsById(searchedMeetings, excludeIds),
          ...reserved,
        ];
        const result = findNextAvailableSlots({
          startDate: start,
          meetings,
          durationMinutes: stepMinutes,
          resolveTimeRanges: (day) => resolveRangesForDay(working, day),
          now: new Date(),
          omitDateStarts,
        });
        trackEvent("availability_presented", {
          outcome: "success",
          ...(result.date ? { date: result.date } : {}),
          slot_count: result.days.reduce((sum, day) => sum + day.slots.length, 0),
          searched_days: result.searchedDays,
          duration_minutes: stepMinutes,
        });
        return JSON.stringify({
          ...result,
          days: result.days.map((day) => ({
            ...day,
            dayLabel: formatKyivDayLabel(day.date, todayKyiv),
          })),
          stepMinutes,
          ...(excludeIds?.length ? { excludeMeetingIds: excludeIds } : {}),
          ...(searchedMeetings.length >= RANGED_MEETINGS_LIMIT ? { truncated: true } : {}),
        });
      } catch (error) {
        const message = errorMessage(error);
        trackToolError("present_availability_slots", message);
        return JSON.stringify({ error: message, slots: [] });
      }
    },
    {
      name: "present_availability_slots",
      description:
        "Compute free appointment slots from CRM meetings and CReservedTime. Pass date for one day, or omit date for the next open days (optional startDate / afterDate). When rescheduling, pass excludeMeetingIds for the visit being moved. Always pass durationMinutes from the matched service. Reuse <availability> in context when days[] already covers the patient's choice — call only when the block is missing, the day is not listed, they want other dates (afterDate / «Інша дата»), stepMinutes differs, excludeMeetingIds differs (MOVE), truncated and they want more, or create_meeting/reschedule_meeting failed because the slot was taken. Returns JSON { days: [{ date, dayLabel, slots }], stepMinutes, excludeMeetingIds?, truncated? }.",
      schema: z.object({
        date: DAY_SCHEMA.optional().describe(
          "Specific calendar day YYYY-MM-DD. Omit to search for the next available days.",
        ),
        startDate: DAY_SCHEMA.optional().describe(
          "When date is omitted: first day of the next-available search (default Kyiv today).",
        ),
        afterDate: DAY_SCHEMA.optional().describe(
          "When date is omitted: skip this day and all earlier — search starts the next calendar day. Required when the user rejects a date or asks for other dates (коли ще / покажи ще). If both afterDate and startDate are set, the later day wins.",
        ),
        durationMinutes: z
          .number()
          .int()
          .min(15)
          .max(180)
          .optional()
          .describe("Slot length in minutes from the service duration (default 30)"),
        excludeMeetingIds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Meeting ids to ignore as busy (pass the meeting being rescheduled so later times in that block can open; its current start is not offered).",
          ),
      }),
    },
  );
};

import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { trackEvent, trackToolError } from "../analytics/track.js";
import {
  CLINIC_SLOT_MINUTES,
  CONTEXT_TAGS,
  MAX_AVAILABILITY_SEARCH_DAYS,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
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
  findPreviousAvailableSlots,
  formatKyivDayLabel,
  kyivToday,
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
  searchDirection?: "exact" | "earlier" | "later" | "nearest";
  searchAnchor?: string;
  searchedFrom?: string;
  searchedThrough?: string;
  query?: AvailabilityQuery;
};

export type AvailabilityQuery = {
  kind: "exact" | "earlier" | "later" | "nearest";
  date?: string;
  anchor?: string;
  rangeFrom?: string;
  rangeThrough?: string;
  coverageComplete: boolean;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_ISO_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/;

export const KYIV_DAY_SCHEMA = z
  .string()
  .regex(DAY_RE)
  .describe("Calendar day YYYY-MM-DD");

export const KYIV_LOCAL_ISO_SCHEMA = z
  .string()
  .regex(LOCAL_ISO_RE)
  .describe("Datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)");

const ymdOf = (value: string): string | undefined => {
  if (DAY_RE.test(value)) {
    return value;
  }
  const prefix = value.slice(0, 10);
  return prefix.length === 10 && DAY_RE.test(prefix) ? prefix : undefined;
};

export const alignToAnchors = (
  value: string | undefined,
  anchors: readonly string[],
): string | undefined => {
  if (value == null) {
    return value;
  }
  const ymd = ymdOf(value);
  if (!ymd) {
    return value;
  }
  const monthDay = ymd.slice(5);
  for (const anchor of anchors) {
    const anchorYmd = ymdOf(anchor);
    if (anchorYmd && anchorYmd.slice(5) === monthDay) {
      return value.length === 10 ? anchorYmd : `${anchorYmd}${value.slice(10)}`;
    }
  }
  return value;
};

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
  const searchDirection =
    record.searchDirection === "exact"
    || record.searchDirection === "earlier"
    || record.searchDirection === "later"
    || record.searchDirection === "nearest"
      ? record.searchDirection
      : undefined;
  const searchAnchor =
    typeof record.searchAnchor === "string" && DAY_RE.test(record.searchAnchor)
      ? record.searchAnchor
      : undefined;
  const searchedFrom =
    typeof record.searchedFrom === "string" && DAY_RE.test(record.searchedFrom)
      ? record.searchedFrom
      : undefined;
  const searchedThrough =
    typeof record.searchedThrough === "string" && DAY_RE.test(record.searchedThrough)
      ? record.searchedThrough
      : undefined;
  const queryRecord = asJsonRecord(record.query);
  const queryKind =
    queryRecord?.kind === "exact"
    || queryRecord?.kind === "earlier"
    || queryRecord?.kind === "later"
    || queryRecord?.kind === "nearest"
      ? queryRecord.kind
      : searchDirection;
  const query: AvailabilityQuery | undefined = queryKind
    ? {
        kind: queryKind,
        ...(typeof queryRecord?.date === "string" && DAY_RE.test(queryRecord.date)
          ? { date: queryRecord.date }
          : queryKind === "exact" && searchAnchor ? { date: searchAnchor } : {}),
        ...(typeof queryRecord?.anchor === "string" && DAY_RE.test(queryRecord.anchor)
          ? { anchor: queryRecord.anchor }
          : searchAnchor ? { anchor: searchAnchor } : {}),
        ...(typeof queryRecord?.rangeFrom === "string" && DAY_RE.test(queryRecord.rangeFrom)
          ? { rangeFrom: queryRecord.rangeFrom }
          : searchedFrom ? { rangeFrom: searchedFrom } : {}),
        ...(typeof queryRecord?.rangeThrough === "string" && DAY_RE.test(queryRecord.rangeThrough)
          ? { rangeThrough: queryRecord.rangeThrough }
          : searchedThrough ? { rangeThrough: searchedThrough } : {}),
        coverageComplete: queryRecord?.coverageComplete !== false && truncated !== true,
      }
    : undefined;
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
      ...(searchDirection ? { searchDirection } : {}),
      ...(searchAnchor ? { searchAnchor } : {}),
      ...(searchedFrom ? { searchedFrom } : {}),
      ...(searchedThrough ? { searchedThrough } : {}),
      ...(query ? { query } : {}),
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
      ...(searchDirection ? { searchDirection } : {}),
      ...(searchAnchor ? { searchAnchor } : {}),
      ...(searchedFrom ? { searchedFrom } : {}),
      ...(searchedThrough ? { searchedThrough } : {}),
      ...(query ? { query } : {}),
    };
  }

  return null;
};

const sameExcludeIds = (
  left: string[] | undefined,
  right: string[] | undefined,
): boolean => {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
};

export const presentAvailabilitySlotsArgsSchema = z.object({
  direction: z.enum(["exact", "earlier", "later", "nearest"]).optional().describe(
    "Semantic search intent. Runtime owns all cursor dates; use exact for a named day, earlier/later for alternatives, nearest for the next availability.",
  ),
  date: KYIV_DAY_SCHEMA.optional().describe(
    "Specific calendar day YYYY-MM-DD. Omit to search for the next available days.",
  ),
  startDate: KYIV_DAY_SCHEMA.optional().describe(
    "When date is omitted: first day of the next-available search (default Kyiv today).",
  ),
  afterDate: KYIV_DAY_SCHEMA.optional().describe(
    "When date is omitted: skip this day and all earlier — search starts the next calendar day. Required when the user rejects a date or asks for other dates («Інша дата» / Another date / коли ще / покажи ще). afterDate is the last offered day, or the specific day they rejected. If both afterDate and startDate are set, the later day wins.",
  ),
  beforeDate: KYIV_DAY_SCHEMA.optional().describe(
    "When direction is earlier: exclusive upper bound. Runtime supplies the rejected or earliest offered day.",
  ),
  durationMinutes: z.coerce
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
});

export type AvailabilitySlotsToolArgs = z.infer<typeof presentAvailabilitySlotsArgsSchema>;

/**
 * When the request matches the checkpointed snapshot, return the same JSON shape as a
 * CRM present_availability_slots success (no search_meetings). Null = cache miss.
 */
export const tryAvailabilityCacheHit = (
  ctx: AvailabilityContext | null | undefined,
  input: AvailabilitySlotsToolArgs,
): { json: string; kind: "date_list" | "day_slots" } | null => {
  if (!ctx || (ctx.days.length === 0 && !ctx.searchDirection)) {
    return null;
  }
  // Paging forward/backward or shifting the search window always hits CRM.
  // An unqualified call must never replay an unrelated snapshot.
  if (input.afterDate || input.beforeDate || input.startDate || (!input.direction && !input.date)) {
    return null;
  }
  const stepMinutes = input.durationMinutes ?? CLINIC_SLOT_MINUTES;
  if (stepMinutes !== ctx.stepMinutes) {
    return null;
  }
  if (!sameExcludeIds(input.excludeMeetingIds, ctx.excludeMeetingIds)) {
    return null;
  }

  const shared = {
    stepMinutes: ctx.stepMinutes,
    ...(ctx.excludeMeetingIds?.length ? { excludeMeetingIds: ctx.excludeMeetingIds } : {}),
    cacheHit: true as const,
  };

  if (input.date) {
    const query = ctx.query;
    const coveredByQuery =
      query?.coverageComplete === true
      && query.rangeFrom != null
      && query.rangeThrough != null
      && query.rangeFrom <= input.date
      && input.date <= query.rangeThrough;
    if (query?.kind === "exact" && query.date !== input.date && !coveredByQuery) {
      return null;
    }
    const day = ctx.days.find((entry) => entry.date === input.date);
    if (!day) {
      return null;
    }
    return {
      kind: "day_slots",
      json: JSON.stringify({
        slots: day.slots,
        date: day.date,
        ...(day.dayLabel ? { dayLabel: day.dayLabel } : {}),
        ...(ctx.searchDirection ? { searchDirection: ctx.searchDirection } : {}),
        ...(ctx.searchAnchor ? { searchAnchor: ctx.searchAnchor } : {}),
        ...(ctx.query ? { query: ctx.query } : {}),
        ...shared,
      }),
    };
  }

  if (input.direction == null || (ctx.query && ctx.query.kind !== input.direction)) {
    return null;
  }

  return {
    kind: "date_list",
    json: JSON.stringify({
      days: ctx.days,
      ...shared,
      ...(ctx.truncated ? { truncated: true } : {}),
      ...(ctx.searchDirection ? { searchDirection: ctx.searchDirection } : {}),
      ...(ctx.searchAnchor ? { searchAnchor: ctx.searchAnchor } : {}),
      ...(ctx.searchedFrom ? { searchedFrom: ctx.searchedFrom } : {}),
      ...(ctx.searchedThrough ? { searchedThrough: ctx.searchedThrough } : {}),
      ...(ctx.query ? { query: ctx.query } : {}),
    }),
  };
};

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
  if (start < input.today) {
    start = input.today;
  }
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
      direction?: "exact" | "earlier" | "later" | "nearest";
      date?: string;
      startDate?: string;
      afterDate?: string;
      beforeDate?: string;
      durationMinutes?: number;
      excludeMeetingIds?: string[];
    }) => {
      try {
        const stepMinutes = input.durationMinutes ?? CLINIC_SLOT_MINUTES;
        const excludeIds = input.excludeMeetingIds;
        const todayKyiv = kyivToday();

        if (input.date) {
          if (input.date < todayKyiv) {
            return JSON.stringify({
              error: "Requested availability date is in the past",
              date: input.date,
              stepMinutes,
            });
          }
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
            searchDirection: "exact",
            searchAnchor: input.date,
            searchedFrom: input.date,
            searchedThrough: input.date,
            query: {
              kind: "exact",
              date: input.date,
              anchor: input.date,
              rangeFrom: input.date,
              rangeThrough: input.date,
              coverageComplete: true,
            },
            ...(excludeIds?.length ? { excludeMeetingIds: excludeIds } : {}),
          });
        }

        const today = todayKyiv;
        const direction = input.direction === "earlier" ? "earlier" : input.direction === "nearest" ? "nearest" : "later";
        const beforeDate = input.beforeDate ?? today;
        const start = resolveNextAvailableStart({
          ...(input.startDate ? { startDate: input.startDate } : {}),
          ...(input.afterDate ? { afterDate: input.afterDate } : {}),
          today,
        });
        const end = addCalendarDays(start, MAX_AVAILABILITY_SEARCH_DAYS - 1);
        const backwardEnd = addCalendarDays(beforeDate, -1);
        const backwardStart = addCalendarDays(
          backwardEnd,
          -(MAX_AVAILABILITY_SEARCH_DAYS - 1),
        ) < today
          ? today
          : addCalendarDays(backwardEnd, -(MAX_AVAILABILITY_SEARCH_DAYS - 1));
        const backwardSearchable = backwardEnd >= today;
        const meetingFrom = direction === "earlier" && backwardSearchable ? backwardStart : start;
        const meetingTo = direction === "earlier" && backwardSearchable ? backwardEnd : end;
        const [working, raw, reserved] = await Promise.all([
          fetchWorkingCalendar(callTool, assignedUserId),
          callTool("search_meetings", {
            dateFrom: meetingFrom,
            dateTo: meetingTo,
            assignedUserId,
            limit: RANGED_MEETINGS_LIMIT,
          }),
          searchReservedTimes(callTool, assignedUserId, meetingFrom, meetingTo),
        ]);
        const searchedMeetings = extractMeetingsFromSearchResult(raw);
        const omitDateStarts = startsOfExcludedMeetings(searchedMeetings, excludeIds);
        const meetings = [
          ...excludeMeetingsById(searchedMeetings, excludeIds),
          ...reserved,
        ];
        const result =
          direction === "earlier"
            ? findPreviousAvailableSlots({
                beforeDate,
                meetings,
                durationMinutes: stepMinutes,
                resolveTimeRanges: (day) => resolveRangesForDay(working, day),
                now: new Date(),
                omitDateStarts,
              })
            : findNextAvailableSlots({
                startDate: start,
                meetings,
                durationMinutes: stepMinutes,
                resolveTimeRanges: (day) => resolveRangesForDay(working, day),
                now: new Date(),
                omitDateStarts,
              });
        const searchedFrom =
          direction === "earlier"
            ? result.searchedDays > 0
              ? addCalendarDays(backwardEnd, -(result.searchedDays - 1))
              : today
            : start;
        const searchedThrough =
          direction === "earlier"
            ? backwardEnd
            : addCalendarDays(start, Math.max(0, result.searchedDays - 1));
        trackEvent("availability_presented", {
          outcome: "success",
          ...(result.date ? { date: result.date } : {}),
          slot_count: result.days.reduce((sum, day) => sum + day.slots.length, 0),
          searched_days: result.searchedDays,
          duration_minutes: stepMinutes,
          direction,
        });
        return JSON.stringify({
          ...result,
          days: result.days.map((day) => ({
            ...day,
            dayLabel: formatKyivDayLabel(day.date, todayKyiv),
          })),
          stepMinutes,
          searchDirection: direction,
          ...(direction === "earlier"
            ? { searchAnchor: beforeDate }
            : { searchAnchor: input.afterDate ?? start }),
          searchedFrom,
          searchedThrough,
          query: {
            kind: direction,
            anchor: direction === "earlier" ? beforeDate : input.afterDate ?? start,
            rangeFrom: searchedFrom,
            rangeThrough: searchedThrough,
            coverageComplete: searchedMeetings.length < RANGED_MEETINGS_LIMIT,
          },
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
        `Compute free appointment slots from CRM meetings and CReservedTime. Pass date for one day, or omit date for the next open days (optional direction, startDate, afterDate, or beforeDate). Use direction earlier/later/nearest for conversational alternatives; runtime owns cursor dates. When rescheduling, pass excludeMeetingIds for the visit being moved. Always pass durationMinutes from the matched service. Always call this tool to show DATE (and to re-show a day already in the last snapshot) — the graph may return the checkpointed snapshot without a CRM search when the request matches. Call with direction later when they want other dates («${OTHER_DATE_LABEL}» / "${OTHER_DATE_LABEL_EN}"), or direction earlier for sooner calendar dates. Do not invent days or HH:mm and do not quote a free/busy list from memory — the graph attaches DATE/TIME text and reply keyboards from this tool result.`,
      schema: presentAvailabilitySlotsArgsSchema,
    },
  );
};

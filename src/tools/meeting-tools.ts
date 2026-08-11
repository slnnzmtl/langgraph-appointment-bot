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
  excludeMeetingsById,
  extractMeetingsFromSearchResult,
  fallbackClinicTimeRanges,
  findNextAvailableSlots,
  formatKyivLocalIso,
  normalizeLocalIsoDatetime,
  resolveDayTimeRanges,
  type TimeRangePair,
  type WorkingTimeCalendarLike,
} from "./availability-slots.js";
import { contactMissingFields } from "./contact-tools.js";
import { toToolResult } from "./tool-result.js";

export type MeetingToolsOptions = {
  callTool: McpCallTool;
  assignedUserId: string;
};

/**
 * HITL resume payloads: Telegram Yes/No buttons send `{ confirmed }`, chat text sent while the
 * confirm card is pending sends `{ userReply }`. Anything else counts as a decline.
 */
type ConfirmDecision =
  | { kind: "confirmed" }
  | { kind: "chatReply"; userReply: string }
  | { kind: "declined" };

const parseConfirmDecision = (decision: unknown): ConfirmDecision => {
  if (typeof decision !== "object" || decision === null) {
    return { kind: "declined" };
  }
  const { confirmed, userReply } = decision as { confirmed?: unknown; userReply?: unknown };
  if (confirmed === true) {
    return { kind: "confirmed" };
  }
  const reply = typeof userReply === "string" ? userReply.trim() : "";
  return reply.length > 0 ? { kind: "chatReply", userReply: reply } : { kind: "declined" };
};

type ConfirmDraft = {
  confirmMessage: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

const parseEntityRecord = (raw: unknown): Record<string, unknown> => {
  let entity: unknown = raw;
  if (typeof entity === "string") {
    try {
      entity = JSON.parse(entity) as unknown;
    } catch {
      return {};
    }
  }
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return {};
  }
  return entity as Record<string, unknown>;
};

/** Execute MCP write and normalize success/error JSON (no HITL). */
const runMeetingWrite = async (execute: () => Promise<unknown>): Promise<string> => {
  try {
    return toToolResult(await execute());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
};

/** Shared HITL pause for create / cancel / reschedule — Telegram reuses confirm_booking Yes/No. */
const withUserConfirm = async (
  draft: ConfirmDraft,
  execute: () => Promise<unknown>,
  cancelledMessage = "Cancelled by user.",
): Promise<string> => {
  const decision = parseConfirmDecision(interrupt({ type: "confirm_booking", draft }));
  if (decision.kind === "confirmed") {
    return runMeetingWrite(execute);
  }
  if (decision.kind === "chatReply") {
    return JSON.stringify({
      awaitingConfirmation: true,
      userReply: decision.userReply,
      draft,
      hint: "Nothing was written. The user replied in chat instead of tapping Yes/No. If this reply confirms the action, call this tool again with identical arguments plus confirmationGiven true. Otherwise handle their message normally.",
    });
  }
  return JSON.stringify({ cancelled: true, message: cancelledMessage });
};

const DAY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar day YYYY-MM-DD");

/** MCP search_meetings validates limit <= 200. */
const RANGED_MEETINGS_LIMIT = 200;

const CONFIRM_MESSAGE_SCHEMA = z
  .string()
  .min(1)
  .describe(
    "Short Yes/No question in the patient's chat language (e.g. Підтвердити запис?). For HITL button caption only — not for chat text. Ignore supervisor prompt language.",
  );

const CONFIRMATION_GIVEN_SCHEMA = z
  .boolean()
  .optional()
  .default(false)
  .describe(
    "Set true only when the user explicitly confirmed in chat after a prior call showed HITL buttons. Default false: pauses for Yes/No before writing.",
  );

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

/** Shared by list_planned_meetings tool and booking prepare prefetch. */
export const lookupPlannedMeetings = async (
  callTool: McpCallTool,
  contactId: string,
  dateFrom?: string,
): Promise<BookingContext | null> => {
  try {
    const from = dateFrom ?? formatKyivLocalIso(new Date()).slice(0, 10);
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
    return { meetings: extractPlannedMeetingsFromEntityResult(raw), dateFrom: from };
  } catch {
    return null;
  }
};

export const createMeetingTools = (options: MeetingToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const presentAvailabilitySlots = tool(
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
          const meetings = excludeMeetingsById(
            extractMeetingsFromSearchResult(raw),
            excludeIds,
          );
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
        const meetings = excludeMeetingsById(
          extractMeetingsFromSearchResult(raw),
          excludeIds,
        );
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
        "Compute free appointment slots from CRM meetings (search_meetings). Pass date for one day, or omit date to find the next open days with free slots (up to 5 days; optional startDate / afterDate). Use afterDate when the user wants other dates after a proposed day (коли ще / покажи ще / another day) — set afterDate to the last proposed YYYY-MM-DD. When rescheduling, pass excludeMeetingIds with the meeting being moved so its current slot is free. Always pass durationMinutes from the matched service when known. Returns JSON { days: [{ date, slots }], date, slots, stepMinutes, searchedDays? }. Prefer days[]; date/slots mirror the first day. List every returned day and all slot labels — do not invent times or claim a day is the only option unless days is empty after afterDate.",
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
            "Meeting ids to ignore as busy (pass the meeting being rescheduled so its current slot is offered).",
          ),
      }),
    },
  );

  const listPlannedMeetings = tool(
    async (input: { contactId: string; dateFrom?: string }) => {
      const listed = await lookupPlannedMeetings(callTool, input.contactId, input.dateFrom);
      return JSON.stringify(listed ?? { error: "Unable to list planned meetings", meetings: [] });
    },
    {
      name: "list_planned_meetings",
      description:
        "List upcoming Planned meetings for a Contact (parentId). Use before cancel or reschedule, or when the user asks what is booked. Pass contactId from find_contact_by_telegram / create_contact. Optional dateFrom defaults to Kyiv today. Returns { meetings: [{ id, name, dateStart, dateEnd }] }.",
      schema: z.object({
        contactId: z.string().min(1).describe("Patient Contact id"),
        dateFrom: DAY_SCHEMA.optional().describe(
          "First day to include (YYYY-MM-DD). Default: Kyiv today.",
        ),
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
      confirmationGiven?: boolean;
    }) => {
      let contact: Record<string, unknown> = {};
      try {
        contact = parseEntityRecord(
          await callTool("get_entity", {
            entityType: "Contact",
            entityId: input.contactId,
          }),
        );
      } catch {
        contact = {};
      }
      const missing = contactMissingFields(contact);
      if (missing.length > 0) {
        return JSON.stringify({
          error: "Contact incomplete",
          missingFields: missing,
          hint: "Ask for these fields, call update_contact, then retry create_meeting.",
        });
      }

      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft = {
        name: input.name,
        dateStart,
        dateEnd,
        confirmMessage: input.confirmMessage.trim(),
      };
      const execute = () =>
        callTool("create_meeting", {
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

      if (input.confirmationGiven) {
        return runMeetingWrite(execute);
      }
      return withUserConfirm(draft, execute, "Booking cancelled by user.");
    },
    {
      name: "create_meeting",
      description:
        "Book an appointment when contact, service, and start/end are known. Call immediately. Requires confirmMessage (patient language). First call pauses for HITL Yes/No buttons; after explicit chat affirmation, re-call with the same args and confirmationGiven true. Injects assignedUserId and Contact parent fields.",
      schema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'Meeting title as "[service-name]: [firstName lastName]" (e.g. "Консультація: Daniel Kovalenko")',
          ),
        dateStart: z.string().describe("Start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("End datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        contactId: z.string().min(1).describe("Patient Contact id"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        serviceId: z.string().min(1).describe("Required cService entity id (resolve via list_services)"),
        description: z.string().optional(),
        location: z.string().optional(),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  const cancelMeeting = tool(
    async (input: {
      meetingId: string;
      confirmMessage: string;
      name?: string;
      confirmationGiven?: boolean;
    }) => {
      const draft: ConfirmDraft = {
        confirmMessage: input.confirmMessage.trim(),
        ...(input.name ? { name: input.name } : {}),
      };
      const execute = () =>
        callTool("update_meeting", {
          meetingId: input.meetingId,
          status: "Not Held",
        });

      if (input.confirmationGiven) {
        return runMeetingWrite(execute);
      }
      return withUserConfirm(draft, execute, "Cancellation cancelled by user.");
    },
    {
      name: "cancel_meeting",
      description:
        "Soft-cancel an existing Planned meeting (status Not Held). Resolve meetingId via list_planned_meetings first. Requires confirmMessage (patient language). First call pauses for HITL Yes/No buttons; after explicit chat affirmation, re-call with the same args and confirmationGiven true.",
      schema: z.object({
        meetingId: z.string().min(1).describe("Meeting id from list_planned_meetings"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        name: z
          .string()
          .optional()
          .describe("Meeting name for the Yes/No caption (from list_planned_meetings)"),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  const rescheduleMeeting = tool(
    async (input: {
      meetingId: string;
      dateStart: string;
      dateEnd: string;
      confirmMessage: string;
      name?: string;
      confirmationGiven?: boolean;
    }) => {
      const dateStart = normalizeLocalIsoDatetime(input.dateStart);
      const dateEnd = normalizeLocalIsoDatetime(input.dateEnd);
      const draft: ConfirmDraft = {
        confirmMessage: input.confirmMessage.trim(),
        dateStart,
        dateEnd,
        ...(input.name ? { name: input.name } : {}),
      };
      const execute = () =>
        callTool("update_meeting", {
          meetingId: input.meetingId,
          dateStart,
          dateEnd,
        });

      if (input.confirmationGiven) {
        return runMeetingWrite(execute);
      }
      return withUserConfirm(draft, execute, "Reschedule cancelled by user.");
    },
    {
      name: "reschedule_meeting",
      description:
        "Move an existing meeting to a new start/end (same meeting id). Resolve meetingId via list_planned_meetings; pick a free slot with present_availability_slots (pass excludeMeetingIds). Requires confirmMessage (patient language). First call pauses for HITL Yes/No buttons; after explicit chat affirmation, re-call with the same args and confirmationGiven true.",
      schema: z.object({
        meetingId: z.string().min(1).describe("Meeting id from list_planned_meetings"),
        dateStart: z.string().describe("New start datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        dateEnd: z.string().describe("New end datetime YYYY-MM-DDTHH:mm:ss (Kyiv local)"),
        confirmMessage: CONFIRM_MESSAGE_SCHEMA,
        name: z
          .string()
          .optional()
          .describe("Meeting name for the Yes/No caption (from list_planned_meetings)"),
        confirmationGiven: CONFIRMATION_GIVEN_SCHEMA,
      }),
    },
  );

  return [
    presentAvailabilitySlots,
    createMeeting,
    listPlannedMeetings,
    cancelMeeting,
    rescheduleMeeting,
  ];
};

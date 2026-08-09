import {
  CLINIC_CLOSE_HOUR,
  CLINIC_OPEN_HOUR,
  CLINIC_SLOT_MINUTES,
  CLINIC_SLOT_TZ,
  MAX_PRESENTED_SLOTS,
} from "../shared/clinic-constants.js";

export {
  CLINIC_CLOSE_HOUR,
  CLINIC_OPEN_HOUR,
  CLINIC_SLOT_MINUTES,
  CLINIC_SLOT_TZ,
  MAX_PRESENTED_SLOTS,
} from "../shared/clinic-constants.js";

export type BusyMeeting = {
  dateStart: string;
  dateEnd: string;
  status?: string;
};

export type AvailabilitySlot = {
  id: string;
  label: string;
  dateStart: string;
  dateEnd: string;
};

export type TimeRangePair = [string, string];

/** Minimal calendar shape needed to resolve open ranges for a day. */
export type WorkingTimeCalendarLike = {
  timeRanges?: TimeRangePair[] | null;
  weekdays?: Record<string, boolean>;
  weekdayTimeRanges?: Record<string, TimeRangePair[] | null>;
};

export type ComputeFreeSlotsInput = {
  day: string;
  meetings: BusyMeeting[];
  /** Open intervals as HH:mm pairs. Empty = closed day. */
  timeRanges: TimeRangePair[];
  stepMinutes?: number;
  maxSlots?: number;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const BUSY_STATUSES = new Set(["Planned", "Held"]);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Fallback open range from clinic constants (when CRM working time is unavailable). */
export const fallbackClinicTimeRanges = (): TimeRangePair[] => [
  [`${pad2(CLINIC_OPEN_HOUR)}:00`, `${pad2(CLINIC_CLOSE_HOUR)}:00`],
];

/** Local Kyiv wall-clock ISO without offset (matches EspoCRM MCP meeting tools). */
export const localIso = (day: string, hour: number, minute: number): string =>
  `${day}T${pad2(hour)}:${pad2(minute)}:00`;

/** Normalize wall times to `YYYY-MM-DDTHH:mm:ss` for EspoCRM MCP meeting tools. */
export const normalizeLocalIsoDatetime = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!match) {
    throw new Error(`Invalid datetime: ${value}`);
  }
  const seconds = match[3] ?? "00";
  return `${match[1]}T${match[2]}:${seconds}`;
};

/** Normalize EspoCRM wall times (`YYYY-MM-DD HH:mm:ss`, ISO, or date-only) for Date.parse. */
const toMillis = (iso: string): number => {
  const trimmed = iso.trim();
  const withT = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : normalizeLocalIsoDatetime(trimmed);
  const ms = Date.parse(withT);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid datetime: ${iso}`);
  }
  return ms;
};

const overlaps = (
  startA: number,
  endA: number,
  startB: number,
  endB: number,
): boolean => startA < endB && endA > startB;

const formatLabel = (hour: number, minute: number): string =>
  `${pad2(hour)}:${pad2(minute)}`;

/** Parse HH:mm to minutes from midnight; returns null if invalid. */
const parseHmToMinutes = (hm: string): number | null => {
  const match = TIME_RE.exec(hm.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
};

/**
 * EspoCRM weekday index for a YYYY-MM-DD calendar day in Europe/Kyiv.
 * 0 = Sunday … 6 = Saturday (matches WorkingTimeCalendar weekdayN fields).
 */
export const getKyivWeekdayIndex = (day: string): string => {
  if (!DAY_RE.test(day)) {
    throw new Error(`day must be YYYY-MM-DD, got: ${day}`);
  }
  // Noon UTC avoids DST edge cases when reading weekday in Kyiv.
  const instant = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: CLINIC_SLOT_TZ,
    weekday: "short",
  }).format(instant);
  const map: Record<string, string> = {
    Sun: "0",
    Mon: "1",
    Tue: "2",
    Wed: "3",
    Thu: "4",
    Fri: "5",
    Sat: "6",
  };
  const key = map[weekday];
  if (!key) {
    throw new Error(`Unexpected weekday label: ${weekday}`);
  }
  return key;
};

/**
 * Resolve open time ranges for a calendar day from a normalized WorkingTimeCalendar.
 * Closed weekdays return []. Prefer weekdayTimeRanges when non-empty, else timeRanges.
 */
export const resolveDayTimeRanges = (
  calendar: WorkingTimeCalendarLike | null | undefined,
  day: string,
): TimeRangePair[] => {
  if (!calendar) {
    return [];
  }
  const weekday = getKyivWeekdayIndex(day);
  if (calendar.weekdays?.[weekday] !== true) {
    return [];
  }
  const dayRanges = calendar.weekdayTimeRanges?.[weekday];
  if (Array.isArray(dayRanges) && dayRanges.length > 0) {
    return dayRanges;
  }
  return Array.isArray(calendar.timeRanges) ? calendar.timeRanges : [];
};

/**
 * Build free slots for a calendar day by subtracting busy meetings from open ranges.
 * Only Planned/Held meetings block time; Not Held is ignored.
 */
export const computeFreeSlots = (input: ComputeFreeSlotsInput): AvailabilitySlot[] => {
  const {
    day,
    meetings,
    timeRanges,
    stepMinutes = CLINIC_SLOT_MINUTES,
    maxSlots = MAX_PRESENTED_SLOTS,
  } = input;

  if (!DAY_RE.test(day)) {
    throw new Error(`day must be YYYY-MM-DD, got: ${day}`);
  }
  if (stepMinutes <= 0 || timeRanges.length === 0) {
    return [];
  }

  const busy = meetings
    .filter((m) => !m.status || BUSY_STATUSES.has(m.status))
    .map((m) => ({
      start: toMillis(m.dateStart),
      end: toMillis(m.dateEnd),
    }));

  const slots: AvailabilitySlot[] = [];

  for (const [startHm, endHm] of timeRanges) {
    const rangeStart = parseHmToMinutes(startHm);
    const rangeEnd = parseHmToMinutes(endHm);
    if (rangeStart === null || rangeEnd === null || rangeStart >= rangeEnd) {
      continue;
    }

    let minutesFromMidnight = rangeStart;
    while (minutesFromMidnight + stepMinutes <= rangeEnd) {
      const hour = Math.floor(minutesFromMidnight / 60);
      const minute = minutesFromMidnight % 60;
      const endTotal = minutesFromMidnight + stepMinutes;
      const endHour = Math.floor(endTotal / 60);
      const endMinute = endTotal % 60;

      const dateStart = localIso(day, hour, minute);
      const dateEnd = localIso(day, endHour, endMinute);
      const startMs = toMillis(dateStart);
      const endMs = toMillis(dateEnd);

      const blocked = busy.some((b) => overlaps(startMs, endMs, b.start, b.end));
      if (!blocked) {
        const id = `${day}T${pad2(hour)}${pad2(minute)}`;
        slots.push({
          id,
          label: formatLabel(hour, minute),
          dateStart,
          dateEnd,
        });
        if (slots.length >= maxSlots) {
          return slots;
        }
      }

      minutesFromMidnight += stepMinutes;
    }
  }

  return slots;
};

export const extractMeetingsFromSearchResult = (raw: unknown): BusyMeeting[] => {
  if (typeof raw === "string") {
    try {
      return extractMeetingsFromSearchResult(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }

  if (!raw || typeof raw !== "object") {
    return [];
  }

  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.meetings)
    ? record.meetings
    : Array.isArray(record.list)
      ? record.list
      : Array.isArray(raw)
        ? raw
        : [];

  const out: BusyMeeting[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;
    if (typeof m.dateStart !== "string" || typeof m.dateEnd !== "string") {
      continue;
    }
    out.push({
      dateStart: m.dateStart,
      dateEnd: m.dateEnd,
      ...(typeof m.status === "string" ? { status: m.status } : {}),
    });
  }
  return out;
};

/** Clinic open hours and slot step (MVP constants; env overrides deferred to Phase 4b). */
export const CLINIC_SLOT_TZ = "Europe/Kyiv";
export const CLINIC_OPEN_HOUR = 9;
export const CLINIC_CLOSE_HOUR = 18;
export const CLINIC_SLOT_MINUTES = 30;
export const MAX_PRESENTED_SLOTS = 12;

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

export type ComputeFreeSlotsInput = {
  day: string;
  meetings: BusyMeeting[];
  openHour?: number;
  closeHour?: number;
  stepMinutes?: number;
  maxSlots?: number;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUSY_STATUSES = new Set(["Planned", "Held"]);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local Kyiv wall-clock ISO without offset (matches EspoCRM MCP meeting tools). */
export const localIso = (day: string, hour: number, minute: number): string =>
  `${day}T${pad2(hour)}:${pad2(minute)}:00`;

/** Normalize EspoCRM wall times (`YYYY-MM-DD HH:mm:ss` or ISO) for Date.parse. */
const toMillis = (iso: string): number => {
  const trimmed = iso.trim();
  const withT = trimmed.includes("T")
    ? trimmed
    : /^\d{4}-\d{2}-\d{2} \d/.test(trimmed)
      ? trimmed.replace(" ", "T")
      : `${trimmed}T00:00:00`;
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

/**
 * Build free slots for a calendar day by subtracting busy meetings from open hours.
 * Only Planned/Held meetings block time; Not Held is ignored.
 */
export const computeFreeSlots = (input: ComputeFreeSlotsInput): AvailabilitySlot[] => {
  const {
    day,
    meetings,
    openHour = CLINIC_OPEN_HOUR,
    closeHour = CLINIC_CLOSE_HOUR,
    stepMinutes = CLINIC_SLOT_MINUTES,
    maxSlots = MAX_PRESENTED_SLOTS,
  } = input;

  if (!DAY_RE.test(day)) {
    throw new Error(`day must be YYYY-MM-DD, got: ${day}`);
  }
  if (stepMinutes <= 0 || openHour >= closeHour) {
    return [];
  }

  const busy = meetings
    .filter((m) => !m.status || BUSY_STATUSES.has(m.status))
    .map((m) => ({
      start: toMillis(m.dateStart),
      end: toMillis(m.dateEnd),
    }));

  const slots: AvailabilitySlot[] = [];
  let minutesFromMidnight = openHour * 60;

  while (minutesFromMidnight + stepMinutes <= closeHour * 60) {
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
        break;
      }
    }

    minutesFromMidnight += stepMinutes;
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

export type BookingScheduleRequest =
  | { kind: "exact"; date: string; preferredTime?: string }
  | { kind: "earlier" }
  | { kind: "later" }
  | { kind: "nearest" };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS: Record<string, number> = {
  січня: 1, січень: 1, лютого: 2, лютий: 2, березня: 3, березень: 3,
  квітня: 4, квітень: 4, травня: 5, травень: 5, червня: 6, червень: 6,
  липня: 7, липень: 7, серпня: 8, серпень: 8, вересня: 9, вересень: 9,
  жовтня: 10, жовтень: 10, листопада: 11, листопад: 11, грудня: 12, грудень: 12,
  января: 1, январь: 1, февраля: 2, февраль: 2, марта: 3, март: 3,
  апреля: 4, апрель: 4, мая: 5, май: 5, июня: 6, июнь: 6,
  июля: 7, июль: 7, августа: 8, август: 8, сентября: 9, сентябрь: 9,
  октября: 10, октябрь: 10, ноября: 11, ноябрь: 11, декабря: 12, декабрь: 12,
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};

const normalize = (text: string): string =>
  text.trim().toLocaleLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");

const addCalendarDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return `${value.getUTCFullYear().toString().padStart(4, "0")}-${(value.getUTCMonth() + 1).toString().padStart(2, "0")}-${value.getUTCDate().toString().padStart(2, "0")}`;
};

const validDay = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
};

const dateFromMonthDay = (day: number, month: number, year: number | undefined, today: string): string | null => {
  const currentYear = Number(today.slice(0, 4));
  if (year != null) return validDay(year, month, day);
  const thisYear = validDay(currentYear, month, day);
  if (!thisYear) return null;
  return thisYear >= today ? thisYear : validDay(currentYear + 1, month, day);
};

const extractPreferredTime = (text: string): string | undefined => {
  const match = text.match(/(?:\b(?:о|в|at|at\s+the)\s*)?(\d{1,2}):(\d{2})\b/i);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return `${hour.toString().padStart(2, "0")}:${match[2]}`;
};

const exactDate = (text: string, today: string): BookingScheduleRequest | null => {
  const normalized = normalize(text);
  const preferredTime = extractPreferredTime(text);
  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const date = validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? preferredTime ? { kind: "exact", date, preferredTime } : { kind: "exact", date } : null;
  }
  const numeric = normalized.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?\b/);
  if (numeric) {
    const date = dateFromMonthDay(Number(numeric[1]), Number(numeric[2]), numeric[3] ? Number(numeric[3]) : undefined, today);
    return date ? preferredTime ? { kind: "exact", date, preferredTime } : { kind: "exact", date } : null;
  }
  const monthNames = Object.keys(MONTHS).join("|");
  const dayFirst = normalized.match(new RegExp(`(?<!\\p{L})(\\d{1,2})\\s+(${monthNames})(?:\\s+(\\d{4}))?(?!\\p{L})`, "iu"));
  const monthFirst = normalized.match(new RegExp(`(?<!\\p{L})(${monthNames})\\s+(\\d{1,2})(?:\\s+(\\d{4}))?(?!\\p{L})`, "iu"));
  const day = dayFirst ? Number(dayFirst[1]) : monthFirst ? Number(monthFirst[2]) : undefined;
  const monthName = dayFirst?.[2] ?? monthFirst?.[1];
  const yearText = dayFirst?.[3] ?? monthFirst?.[3];
  if (day == null || !monthName) return null;
  const month = MONTHS[monthName.toLocaleLowerCase()];
  if (!month) return null;
  const date = dateFromMonthDay(day, month, yearText ? Number(yearText) : undefined, today);
  return date ? preferredTime ? { kind: "exact", date, preferredTime } : { kind: "exact", date } : null;
};

const dayOnlyDate = (text: string, today: string): BookingScheduleRequest | null => {
  const normalized = normalize(text);
  const dayOnly = normalized.match(/(?:^|\s)(\d{1,2})(?:-?(?:й|го|му|е|st|nd|rd|th))?\s+(?:число|числа|день|date)(?!\p{L})/iu);
  const ordinal = normalized.match(/(?:^|\s)(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?=\s|$|[?!.,])/iu);
  const prefixedDay = normalized.match(/(?:^|\s)(?:на|on|for|to)\s+(?:the\s+)?(\d{1,2})(?:-?(?:й|го|му|е|st|nd|rd|th))?(?=\s|$|[?!.,])/iu);
  const day = dayOnly ? Number(dayOnly[1]) : ordinal ? Number(ordinal[1]) : prefixedDay ? Number(prefixedDay[1]) : undefined;
  if (day == null || day < 1 || day > 31) return null;
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));
  let date = validDay(currentYear, currentMonth, day);
  if (!date || date < today) {
    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    date = validDay(nextYear, nextMonth, day);
  }
  if (!date) return null;
  const preferredTime = extractPreferredTime(text);
  return preferredTime ? { kind: "exact", date, preferredTime } : { kind: "exact", date };
};

const relativeDate = (text: string, today: string): BookingScheduleRequest | null => {
  const normalized = normalize(text);
  const offset = /(?:сьогодні|сегодня|today)(?!\p{L})/iu.test(normalized)
    ? 0
    : /(?:післязавтра|послезавтра|day after tomorrow)(?!\p{L})/iu.test(normalized)
      ? 2
      : /(?:завтра|tomorrow)(?!\p{L})/iu.test(normalized)
        ? 1
        : null;
  if (offset == null) return null;
  const date = addCalendarDays(today, offset);
  const preferredTime = extractPreferredTime(text);
  return preferredTime ? { kind: "exact", date, preferredTime } : { kind: "exact", date };
};

/** Resolve explicit calendar/time intent; semantic direction remains model-friendly. */
export const resolveBookingScheduleRequest = (text: string, today: string): BookingScheduleRequest | null => {
  if (!DAY_RE.test(today)) return null;
  const exact = exactDate(text, today) ?? dayOnlyDate(text, today) ?? relativeDate(text, today);
  if (exact) return exact;
  const normalized = normalize(text);
  if (/(?:раніш|раньше|скоріш|earlier|sooner|earliest)/iu.test(normalized)) return { kind: "earlier" };
  if (/(?:пізніш|позніш|далі|коли\s+ще|позже|когда\s+ещ[её]|later|next|when\s+else|another\s+date|other\s+date)/iu.test(normalized)
    || /(?:^|\s)інш(?:а|у|і)\s+дат(?:а|у|и|е)(?:\s|$)/iu.test(normalized)
    || /^(?:інш(?:а|у|і)|друг(?:ая|ую|ие|ой))(?:\s+(?:дат[ауые]|день|дни))?$/iu.test(normalized)) return { kind: "later" };
  if (/(?:найближч|ближч|ближайш|nearest|closest)/iu.test(normalized)) return { kind: "nearest" };
  return null;
};

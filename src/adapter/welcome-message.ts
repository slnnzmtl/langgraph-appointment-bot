import { AIMessage } from "@langchain/core/messages";

import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import { CLINIC_ADDRESS, CLINIC_MAPS_MARKDOWN } from "../shared/clinic-constants.js";
import type { McpCallTool } from "../shared/mcp.js";
import {
  resolveWeekdayTimeRanges,
  type TimeRangePair,
  type WorkingTimeCalendarLike,
} from "../tools/availability-slots.js";
import {
  extractContactIdFromSearchResult,
  lookupContactByTelegram,
} from "../tools/contact-tools.js";
import { lookupPlannedMeetings } from "../tools/planned-meetings.js";
import { getWorkingTime } from "../tools/service-tools.js";

const DAY_LABELS = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"] as const;
/** Mon–Sun display order (EspoCRM weekday 0 = Sunday … 6 = Saturday). */
const DISPLAY_WEEKDAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;
const HOURS_UNAVAILABLE = "Час роботи наразі недоступний.";

const WELCOME_PREFIX = `**Хто я?**

Вітаю! Я — ваш цифровий адміністратор. Я допомагаю швидко та зручно організувати ваш візит до нашого косметологічного кабінету, де лікарка-дерматокосметолог Катерина Федченко дбає про вашу красу за допомогою сучасних методів омолодження та ін'єкційних процедур.

**Що я вмію**:
📅 Допоможу підібрати зручний час, записатися на процедуру, а також змінити або скасувати існуючий запис.
ℹ️ Надам актуальну інформацію про наші послуги, ціни та препарати, які використовуються в клініці.
📍 Підкажу години нашої роботи, як до нас дістатися та контактні дані.
🔔 Завчасно надішлю сповіщення про ваш запланований прийом, щоб ви нічого не пропустили.

❗️ **Важливе уточнення**:
Я створена для вирішення організаційних питань. Я не надаю медичних чи косметологічних консультацій та не підбираю засоби для догляду за шкірою. Для отримання індивідуальних рекомендацій щодо догляду я з радістю запишу вас на особисту консультацію до Катерини!

📍 **Наша адреса**
${CLINIC_ADDRESS}
${CLINIC_MAPS_MARKDOWN}`;

type DayHours = TimeRangePair[] | "вихідний";

const parseCalendar = (workingTimeJson: string): WorkingTimeCalendarLike | null => {
  let value: unknown;
  try {
    value = JSON.parse(workingTimeJson);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { error?: unknown; calendars?: unknown };
  if (typeof record.error === "string") {
    return null;
  }
  const calendars = record.calendars;
  if (!Array.isArray(calendars) || calendars.length === 0) {
    return null;
  }
  return calendars[0] as WorkingTimeCalendarLike;
};

const resolveDayHours = (calendar: WorkingTimeCalendarLike, weekday: string): DayHours => {
  const ranges = resolveWeekdayTimeRanges(calendar, weekday);
  return ranges.length > 0 ? ranges : "вихідний";
};

const hoursKey = (hours: DayHours): string =>
  hours === "вихідний" ? "вихідний" : hours.map(([start, end]) => `${start}-${end}`).join(",");

const formatHours = (hours: DayHours): string =>
  hours === "вихідний" ? "вихідний" : hours.map(([start, end]) => `${start}–${end}`).join(", ");

const weekdayLabel = (weekday: string): string => DAY_LABELS[Number(weekday)]!;

const formatDaySpan = (startIdx: number, endIdx: number): string => {
  const start = weekdayLabel(DISPLAY_WEEKDAYS[startIdx]!);
  const end = weekdayLabel(DISPLAY_WEEKDAYS[endIdx]!);
  return startIdx === endIdx ? start : `${start}–${end}`;
};

const formatCrmWorkingHours = (workingTimeJson: string): string => {
  const calendar = parseCalendar(workingTimeJson);
  if (!calendar) {
    return HOURS_UNAVAILABLE;
  }

  const days = DISPLAY_WEEKDAYS.map((weekday) => resolveDayHours(calendar, weekday));
  const lines: string[] = [];
  let groupStart = 0;
  for (let i = 1; i <= days.length; i += 1) {
    if (i < days.length && hoursKey(days[i]!) === hoursKey(days[groupStart]!)) {
      continue;
    }
    lines.push(`* ${formatDaySpan(groupStart, i - 1)}: ${formatHours(days[groupStart]!)}`);
    groupStart = i;
  }
  return lines.join("\n");
};

const buildWelcomeMessage = (workingTimeJson: string): string =>
  `${WELCOME_PREFIX}

**Години роботи**
${formatCrmWorkingHours(workingTimeJson)}
`;

export const loadWelcomeMessage = async (
  callTool: McpCallTool,
  assignedUserId: string,
): Promise<string> => {
  const raw = await getWorkingTime(callTool, { userId: assignedUserId });
  return buildWelcomeMessage(raw);
};

/** True when this Telegram user has at least one upcoming Planned or Confirmed meeting. */
export const hasUpcomingVisit = async (callTool: McpCallTool): Promise<boolean> => {
  try {
    const contactJson = await lookupContactByTelegram(callTool);
    const contactId = extractContactIdFromSearchResult(contactJson);
    if (!contactId) {
      return false;
    }
    const listed = await lookupPlannedMeetings(callTool, contactId);
    return (listed?.meetings.length ?? 0) > 0;
  } catch {
    return false;
  }
};

export const START_FOLLOW_UP =
  "Хотіли б ви дізнатися детальніше про наші послуги або записатися на прийом? 💬";

/** Compact marker stored in checkpointed history instead of the full patient-visible welcome. */
export const WELCOME_HISTORY_MARKER =
  "[Welcome already sent: who I am, what I can do, address, working hours. Do not greet again.]";

/** History text for /start — patient still sees the full welcome via ctx.reply. */
export const buildStartHistoryText = (_welcome?: string): string =>
  `${WELCOME_HISTORY_MARKER}\n\n${START_FOLLOW_UP}`;

type Graph = ReturnType<ClinicRuntime["getGraph"]>;

/** Append welcome copy to checkpointed messages without running the supervisor. */
export const recordWelcomeInHistory = async (
  graph: Graph,
  threadId: string,
  welcomeText: string,
): Promise<void> => {
  await graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new AIMessage(welcomeText)] },
  );
};

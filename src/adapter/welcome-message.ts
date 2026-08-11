import type { McpCallTool } from "../shared/mcp.js";
import {
  resolveWeekdayTimeRanges,
  type TimeRangePair,
  type WorkingTimeCalendarLike,
} from "../tools/availability-slots.js";
import { getWorkingTime } from "../tools/service-tools.js";

const DAY_LABELS = ["Неділя", "Понеділок", "Вівторок", "Середа", "Четвер", "П'ятниця", "Субота"] as const;
/** Mon–Sun display order (EspoCRM weekday 0 = Sunday … 6 = Saturday). */
const DISPLAY_WEEKDAYS = ["1", "2", "3", "4", "5", "6", "0"] as const;
const HOURS_UNAVAILABLE = "Currently unavailable.";

const WELCOME_PREFIX = `Ласкаво просимо до косметологічної клініки Катерини Федченко!

Ми пропонуємо широкий спектр сучасної косметології та дерматології, щоб підкреслити вашу природну красу та зберегти здоров’я шкіри. Ви можете отримати консультацію або записатися на прийом у будь-який зручний для вас час.

**Наші послуги**

**Консультації та дерматологія**
- Первинна консультація дерматолога-косметолога
- Комплексна дерматоскопія
- Безпечне видалення новоутворень (родимок, бородавок, папілом)

**Ін'єкційна косметологія**
- Ботулінотерапія: корекція мімічних зморшок (Botox, Dysport, Nabota), лікування гіпергідрозу (підвищеної пітливості), мезоботокс
- Контурна пластика: збільшення та моделювання губ, заповнення носослізної борозни та зморшок, гармонізація обличчя (вилиці, підборіддя, кути нижньої щелепи)
- Біоревіталізація та мезотерапія: глибоке зволоження та відновлення шкіри обличчя, зони навколо очей, а також лікування волосся та шкіри голови

**Догляд за шкірою та корекція фігури**
- Продвинуті поверхневі та серединні пілінги
- Ін'єкційні ліполітики для корекції локальних жирових відкладень

Запитайте нас про будь-яку процедуру або оберіть зручний час для візиту!`;

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
  return ranges.length > 0 ? ranges : "closed";
};

const hoursKey = (hours: DayHours): string =>
  hours === "closed" ? "closed" : hours.map(([start, end]) => `${start}-${end}`).join(",");

const formatHours = (hours: DayHours): string =>
  hours === "closed" ? "closed" : hours.map(([start, end]) => `${start}–${end}`).join(", ");

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

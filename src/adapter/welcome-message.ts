import { AIMessage } from "@langchain/core/messages";

import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import { CLINIC_ADDRESS } from "../shared/clinic-constants.js";
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
const HOURS_UNAVAILABLE = "Час роботи наразі недоступний.";

const WELCOME_PREFIX = `✨ Ласкаво просимо до косметологічної клініки Катерини Федченко!

Ми допомагаємо підкреслити вашу природну красу та зберегти здоров’я шкіри 🌿

Напишіть нам, щоб отримати консультацію або обрати зручний час для візиту 🗓️

📋 Наші послуги
👨‍⚕️ Консультації та дерматологія
• Консультація дерматолога-косметолога
• Дерматоскопія 🔍
• Безпечне видалення новоутворень (родимок, бородавок, папілом)

💉 Ін'єкційна косметологія
• Ботулінотерапія: корекція зморшок (Botox, Dysport, Nabota), лікування гіпергідрозу, мезоботокс
• Контурна пластика: аугментація губ 💋, заповнення заломів, контуринг (вилиці, підборіддя, кути щелепи)
• Біоревіталізація та мезотерапія: зволоження шкіри обличчя, зони навколо очей та догляд за волоссям 💆‍♀️

Скинкери & Корекція фігури
• Поверхневі та серединні пілінги 🧪
• Ін'єкційні ліполітики ⏳

📍 ${CLINIC_ADDRESS}`;

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

export const START_FOLLOW_UP =
  "Хотіли б ви дізнатися деталіше про наші послуги або записатися на прийом? 💬";

export const buildStartHistoryText = (welcome: string): string =>
  `${welcome}\n\n${START_FOLLOW_UP}`;

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

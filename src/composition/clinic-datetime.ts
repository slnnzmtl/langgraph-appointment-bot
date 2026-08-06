import type { RuntimeShellFormatters } from "@personal-assistant/supervisor-framework";

import { CLINIC_SLOT_TZ } from "../tools/availability-slots.js";

const pad2 = (n: number): string => String(n).padStart(2, "0");

type KyivYmd = { year: number; month: number; day: number };

/** Calendar Y-M-D in Europe/Kyiv for an instant. */
export const getKyivYmd = (date: Date): KyivYmd => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_SLOT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const byType = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
  };
};

/** YYYY-MM-DD in Europe/Kyiv, optionally shifted by whole calendar days. */
export const kyivCalendarDate = (date: Date, offsetDays = 0): string => {
  const { year, month, day } = getKyivYmd(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
};

const kyivWallClock = (date: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_SLOT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);

  const byType = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );

  return `${byType.weekday} ${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute}:${byType.second}`;
};

/** System metadata block with Kyiv wall clock (not UTC). */
export const formatKyivSystemMetadata: RuntimeShellFormatters["formatSystemMetadata"] = (
  date,
  options,
) => {
  const lines = [
    "<system_metadata>",
    `CURRENT DATETIME (${CLINIC_SLOT_TZ}): ${kyivWallClock(date)}`,
    `TODAY: ${kyivCalendarDate(date, 0)}`,
    `TOMORROW: ${kyivCalendarDate(date, 1)}`,
  ];

  if (options?.runtimeAgent) {
    lines.push(`RUNTIME_AGENT: ${options.runtimeAgent}`);
  }

  lines.push("</system_metadata>");
  return lines.join("\n");
};

export const clinicShellFormatters: RuntimeShellFormatters = {
  formatSystemMetadata: formatKyivSystemMetadata,
};

export const buildClinicSupervisorDynamicContext = (): string =>
  formatKyivSystemMetadata(new Date());

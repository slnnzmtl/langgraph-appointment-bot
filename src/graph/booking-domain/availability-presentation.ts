/**
 * Pure allowlisted availability presentation for decide/effect cards.
 * Extracts ids+labels only — never raw tool bodies.
 */

import {
  EARLIER_DATE_LABEL,
  LATER_DATE_LABEL,
  MAX_PROPOSED_AVAILABILITY_DAYS,
  OTHER_DATE_LABEL,
} from "../../shared/clinic-constants.js";
import { shortDayMonthLabel } from "../../tools/availability-slots.js";

export type AvailabilityPresentationDay = {
  date: string;
  dayLabel?: string;
  slots: Array<{ id: string; label: string }>;
};

export type AvailabilityPresentationChoice = {
  id: string;
  label: string;
  /** Present on date choices and when a time choice is scoped to a day. */
  date?: string;
};

export type AvailabilityPresentation = {
  mode: "date_select" | "time_select";
  snapshotId: string;
  /** Set when mode is time_select. */
  date?: string;
  choices: AvailabilityPresentationChoice[];
};

/** Stable snapshot id from allowlisted presentation inputs (mirrors interaction render). */
export const presentationSnapshotId = (input: {
  serviceId?: string;
  queryKind?: string;
  queryAnchor?: string;
  days: Array<{ date: string }>;
  stepMinutes?: number;
}): string =>
  [
    input.serviceId ?? "",
    input.queryKind ?? "",
    input.queryAnchor ?? "",
    input.days.map((day) => day.date).join(","),
    String(input.stepMinutes ?? ""),
  ].join("|");

/**
 * Project open days into a date_select or time_select presentation.
 * When `selectedDate` matches an open day → time_select; otherwise date_select.
 */
export const projectAvailabilityPresentation = (
  days: AvailabilityPresentationDay[],
  options: {
    selectedDate?: string | null;
    snapshotId: string;
    includeOtherDate?: boolean;
  },
): AvailabilityPresentation | null => {
  const open = days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return null;
  }

  const selected = options.selectedDate?.trim() || null;
  const selectedDay = selected != null
    ? open.find((day) => day.date === selected)
    : undefined;

  if (selectedDay != null) {
    // All slots on the day (tool already caps at MAX_PRESENTED_SLOTS).
    const choices: AvailabilityPresentationChoice[] = [
      ...selectedDay.slots.map((slot) => ({
        id: slot.id,
        label: slot.label,
        date: selectedDay.date,
      })),
      ...(options.includeOtherDate !== false
        ? [{ id: "other_date", label: OTHER_DATE_LABEL }]
        : []),
    ];
    return {
      mode: "time_select",
      snapshotId: options.snapshotId,
      date: selectedDay.date,
      choices,
    };
  }

  const dateDays = open.slice(0, MAX_PROPOSED_AVAILABILITY_DAYS);
  const choices: AvailabilityPresentationChoice[] = [
    ...dateDays.map((day) => ({
      id: day.date,
      label: shortDayMonthLabel(day.dayLabel ?? day.date),
      date: day.date,
    })),
    ...(options.includeOtherDate !== false
      ? [{ id: "other_date", label: OTHER_DATE_LABEL }]
      : []),
  ];
  return {
    mode: "date_select",
    snapshotId: options.snapshotId,
    choices,
  };
};

/** Empty-window earlier/later presentation (no open slots). */
export const projectEmptyAvailabilityPresentation = (
  snapshotId: string,
  options: {
    direction?: "exact" | "earlier" | "later" | "nearest" | "other";
    canSearchEarlier?: boolean;
  } = {},
): AvailabilityPresentation => {
  if (options.direction === "earlier") {
    return {
      mode: "date_select",
      snapshotId,
      choices: [{ id: "later", label: LATER_DATE_LABEL }],
    };
  }
  const choices: AvailabilityPresentationChoice[] = [
    ...(options.canSearchEarlier === true
      ? [{ id: "earlier", label: EARLIER_DATE_LABEL }]
      : []),
    { id: "later", label: LATER_DATE_LABEL },
  ];
  return { mode: "date_select", snapshotId, choices };
};

export const labelsFromPresentation = (
  presentation: AvailabilityPresentation,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const choice of presentation.choices) {
    labels[choice.id] = choice.label;
  }
  return labels;
};

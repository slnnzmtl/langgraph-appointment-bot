import { visitLabel } from "../shared/meeting-label.js";
import {
  formatKyivDateTimeLabel,
  kyivToday,
  normalizeLocalIsoDatetime,
} from "./availability-slots.js";

export const visitLabelForMeetingStart = (
  name: string,
  dateStart: string,
  today: string = kyivToday(),
): string => visitLabel(name, formatKyivDateTimeLabel(dateStart, today));

/** Patient-facing service + when from the command just sent (not MCP echo). */
export const visitLabelFromCommand = (
  name: string | undefined,
  dateStart: string | undefined,
): string | undefined => {
  const trimmedName = name?.trim();
  const trimmedStart = dateStart?.trim();
  if (trimmedName == null || trimmedName.length === 0
    || trimmedStart == null || trimmedStart.length === 0) {
    return undefined;
  }
  try {
    normalizeLocalIsoDatetime(trimmedStart);
  } catch {
    return undefined;
  }
  const label = visitLabelForMeetingStart(trimmedName, trimmedStart);
  return label.length > 0 ? label : undefined;
};

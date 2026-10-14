import type { BookingAvailabilityScope } from "../graph/booking-draft.js";
import { CLINIC_SLOT_MINUTES } from "../shared/clinic-constants.js";
import {
  alignToAnchors,
  availabilityQueryFromContext,
  availabilityQueryFromCursor,
  type AvailabilityContext,
  type AvailabilityCursor,
  type AvailabilitySlotsToolArgs,
} from "./availability-tools.js";
import { kyivToday } from "./availability-slots.js";

export type BuildAvailabilitySlotsArgsInput = {
  direction: "exact" | "earlier" | "later" | "nearest";
  /** Required for exact when not using offeredDayDate. */
  date?: string;
  offeredDayDate?: string | null;
  availabilityContext?: AvailabilityContext | null;
  availabilityCursor?: AvailabilityCursor | null;
  /** Draft-owned duration and excludeMeetingIds; always wins over loose defaults. */
  scope?: BookingAvailabilityScope;
  availabilityPagedThisTurn: boolean;
  anchors?: readonly string[];
  forceRefresh?: boolean;
};

const firstSnapshotDate = (
  context: AvailabilityContext | null | undefined,
  cursor: AvailabilityCursor | null | undefined,
): string | undefined => context?.days[0]?.date ?? cursor?.firstDate;

const lastSnapshotDate = (
  context: AvailabilityContext | null | undefined,
  cursor: AvailabilityCursor | null | undefined,
): string | undefined => context?.days.at(-1)?.date ?? cursor?.lastDate;

const lastOpenSnapshotDate = (
  context: AvailabilityContext | null | undefined,
): string | undefined => {
  const open = context?.days.filter((day) => day.slots.length > 0) ?? [];
  return open.at(-1)?.date;
};

const applyScope = (
  args: AvailabilitySlotsToolArgs,
  scope: BookingAvailabilityScope | undefined,
): void => {
  if (!scope) {
    return;
  }
  // Scope is authoritative: always replace both fields so invented
  // duration/exclusions cannot survive when the draft omits them.
  args.durationMinutes = scope.durationMinutes ?? CLINIC_SLOT_MINUTES;
  if (scope.excludeMeetingIds != null && scope.excludeMeetingIds.length > 0) {
    args.excludeMeetingIds = [...scope.excludeMeetingIds];
  } else {
    delete args.excludeMeetingIds;
  }
};

const alignCalendarBounds = (
  args: AvailabilitySlotsToolArgs,
  anchors: readonly string[],
  cursor: AvailabilityCursor | null | undefined,
  cursorQuery: ReturnType<typeof availabilityQueryFromCursor>,
): void => {
  for (const key of ["date", "afterDate", "beforeDate", "startDate"] as const) {
    const value = args[key];
    if (typeof value === "string") {
      args[key] = alignToAnchors(value, [
        ...anchors,
        ...(cursor?.firstDate ? [cursor.firstDate] : []),
        ...(cursor?.lastDate ? [cursor.lastDate] : []),
        ...(cursorQuery?.rangeFrom ? [cursorQuery.rangeFrom] : []),
        ...(cursorQuery?.rangeThrough ? [cursorQuery.rangeThrough] : []),
      ]) as never;
    }
  }
};

/**
 * Build canonical present_availability_slots args from a runtime direction.
 * Returns null when earlier/later would exceed one page per turn.
 */
export const buildAvailabilitySlotsArgs = (
  input: BuildAvailabilitySlotsArgsInput,
): AvailabilitySlotsToolArgs | null => {
  const {
    direction,
    date,
    offeredDayDate = null,
    availabilityContext,
    availabilityCursor,
    scope,
    availabilityPagedThisTurn,
    anchors = [],
    forceRefresh = false,
  } = input;

  if ((direction === "earlier" || direction === "later") && availabilityPagedThisTurn) {
    return null;
  }

  const cursor = availabilityCursor;
  const contextQuery = availabilityQueryFromContext(availabilityContext);
  const cursorQuery = availabilityQueryFromCursor(cursor);
  const firstDate = firstSnapshotDate(availabilityContext, cursor);
  const lastDate = lastSnapshotDate(availabilityContext, cursor);
  const lastOpen = lastOpenSnapshotDate(availabilityContext);

  const args: AvailabilitySlotsToolArgs = { direction };

  if (direction === "earlier") {
    args.beforeDate = cursorQuery?.rangeFrom
      ?? contextQuery?.rangeFrom
      ?? firstDate
      ?? kyivToday();
  } else if (direction === "later") {
    const afterDate = cursorQuery?.rangeThrough
      ?? contextQuery?.rangeThrough
      ?? lastOpen
      ?? lastDate;
    if (afterDate) {
      args.afterDate = afterDate;
    }
  } else if (direction === "exact") {
    if (date) {
      args.date = date;
    } else if (offeredDayDate) {
      args.date = offeredDayDate;
    }
  }

  if (direction === "later" && !args.afterDate) {
    delete args.afterDate;
  }
  if (direction === "earlier" && !args.beforeDate) {
    delete args.beforeDate;
  }
  if (direction === "exact" && !args.date) {
    return null;
  }

  if (forceRefresh) {
    args.forceRefresh = true;
  }

  applyScope(args, scope);
  alignCalendarBounds(args, anchors, cursor, cursorQuery);
  return args;
};

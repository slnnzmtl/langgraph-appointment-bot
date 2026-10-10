import type { BookingAvailabilityScope } from "../graph/booking-draft.js";
import type { BookingScheduleRequest } from "../shared/booking-schedule.js";
import {
  alignToAnchors,
  availabilityQueryFromContext,
  availabilityQueryFromCursor,
  type AvailabilityContext,
  type AvailabilityCursor,
  type AvailabilitySlotsToolArgs,
} from "./availability-tools.js";
import { kyivToday } from "./availability-slots.js";

type AvailabilityNormalizationInput = {
  args: AvailabilitySlotsToolArgs;
  runtimeRequest?: BookingScheduleRequest | null;
  offeredDayDate?: string | null;
  availabilityContext?: AvailabilityContext | null;
  availabilityCursor?: AvailabilityCursor | null;
  /** Draft-owned duration and excludeMeetingIds; always wins over model args. */
  scope?: BookingAvailabilityScope;
  availabilityPagedThisTurn: boolean;
  anchors?: readonly string[];
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

const directionFromPatient = (
  runtimeRequest: BookingScheduleRequest | null | undefined,
  offeredDayDate: string | null | undefined,
): "exact" | "earlier" | "later" | "nearest" => {
  if (runtimeRequest?.kind === "exact") {
    return "exact";
  }
  if (
    runtimeRequest?.kind === "earlier"
    || runtimeRequest?.kind === "later"
    || runtimeRequest?.kind === "nearest"
  ) {
    return runtimeRequest.kind;
  }
  if (offeredDayDate) {
    return "exact";
  }
  return "nearest";
};

/**
 * Apply the runtime-owned availability direction and cursor to model arguments.
 * Calendar bounds come from the patient utterance (runtimeRequest) or a matched
 * snapshot day — never from model-invented dates or checkpoint direction alone.
 * When a booking scope is provided, its duration and excludeMeetingIds replace
 * whatever the model passed.
 */
export const normalizeAvailabilityToolArgs = ({
  args: input,
  runtimeRequest = null,
  offeredDayDate = null,
  availabilityContext,
  availabilityCursor,
  scope,
  availabilityPagedThisTurn,
  anchors = [],
}: AvailabilityNormalizationInput): AvailabilitySlotsToolArgs => {
  const args = { ...input };
  const cursor = availabilityCursor;
  const contextQuery = availabilityQueryFromContext(availabilityContext);
  const cursorQuery = availabilityQueryFromCursor(cursor);
  const contextDirection = contextQuery?.kind ?? cursorQuery?.kind;
  const direction = directionFromPatient(runtimeRequest, offeredDayDate);

  const firstDate = firstSnapshotDate(availabilityContext, cursor);
  const lastDate = lastSnapshotDate(availabilityContext, cursor);
  const lastOpen = lastOpenSnapshotDate(availabilityContext);

  if ((direction === "earlier" || direction === "later") && availabilityPagedThisTurn) {
    delete args.afterDate;
    delete args.beforeDate;
    delete args.date;
    delete args.startDate;
    args.direction = contextDirection ?? direction;
  } else if (direction === "earlier") {
    args.direction = "earlier";
    args.beforeDate = cursorQuery?.rangeFrom
      ?? contextQuery?.rangeFrom
      ?? firstDate
      ?? kyivToday();
    delete args.afterDate;
    delete args.startDate;
    delete args.date;
  } else if (direction === "later") {
    args.direction = "later";
    const afterDate = cursorQuery?.rangeThrough
      ?? contextQuery?.rangeThrough
      ?? lastOpen
      ?? lastDate;
    if (afterDate) {
      args.afterDate = afterDate;
    } else {
      delete args.afterDate;
    }
    delete args.beforeDate;
    delete args.startDate;
    delete args.date;
  } else if (direction === "exact") {
    args.direction = "exact";
    if (runtimeRequest?.kind === "exact") {
      args.date = runtimeRequest.date;
    } else if (offeredDayDate) {
      args.date = offeredDayDate;
    }
    delete args.afterDate;
    delete args.beforeDate;
    delete args.startDate;
  } else {
    args.direction = "nearest";
    delete args.date;
    delete args.afterDate;
    delete args.beforeDate;
    delete args.startDate;
  }

  if (direction === "later" && !args.afterDate) {
    delete args.afterDate;
  }
  if (direction === "earlier" && !args.beforeDate) {
    delete args.beforeDate;
  }

  if (scope) {
    if (scope.durationMinutes != null) {
      args.durationMinutes = scope.durationMinutes;
    }
    if (scope.excludeMeetingIds != null) {
      if (scope.excludeMeetingIds.length > 0) {
        args.excludeMeetingIds = [...scope.excludeMeetingIds];
      } else {
        delete args.excludeMeetingIds;
      }
    }
  }

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
  return args;
};

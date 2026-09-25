import {
  alignToAnchors,
  type AvailabilityContext,
  type AvailabilityCursor,
  type AvailabilitySlotsToolArgs,
} from "./availability-tools.js";
import { resolveAvailabilityRequest } from "./availability-request.js";
import { kyivToday } from "./availability-slots.js";

type AvailabilityNormalizationInput = {
  args: AvailabilitySlotsToolArgs;
  humanText: string;
  availabilityContext?: AvailabilityContext | null;
  availabilityCursor?: AvailabilityCursor | null;
  serviceDurationMinutes?: number;
  pickedOfferedDay: boolean;
  consultationAccepted: boolean;
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

/**
 * Apply the runtime-owned availability direction and cursor to model arguments.
 * This is intentionally pure: it only clones and normalizes the model payload.
 */
export const normalizeAvailabilityToolArgs = ({
  args: input,
  humanText,
  availabilityContext,
  availabilityCursor,
  serviceDurationMinutes,
  pickedOfferedDay,
  consultationAccepted,
  availabilityPagedThisTurn,
  anchors = [],
}: AvailabilityNormalizationInput): AvailabilitySlotsToolArgs => {
  const args = { ...input };
  const request = resolveAvailabilityRequest(humanText, kyivToday());
  const cursor = availabilityCursor;
  const contextDirection = availabilityContext?.searchDirection ?? cursor?.direction;
  const direction = consultationAccepted
    ? "nearest"
    : request?.kind === "exact" && !pickedOfferedDay
      ? "exact"
      : request?.kind === "earlier" || request?.kind === "later" || request?.kind === "nearest"
        ? request.kind
        : args.direction
          ?? (args.date ? "exact" : contextDirection === "exact" ? "later" : "nearest");

  const firstDate = firstSnapshotDate(availabilityContext, cursor);
  const lastDate = lastSnapshotDate(availabilityContext, cursor);
  const lastOpen = lastOpenSnapshotDate(availabilityContext);

  if (consultationAccepted) {
    args.direction = "nearest";
    delete args.date;
    delete args.afterDate;
    delete args.beforeDate;
    delete args.startDate;
  } else if ((direction === "earlier" || direction === "later") && availabilityPagedThisTurn) {
    delete args.afterDate;
    delete args.beforeDate;
    delete args.date;
    delete args.startDate;
    args.direction = contextDirection ?? direction;
  } else if (direction === "earlier") {
    args.direction = "earlier";
    args.beforeDate = cursor?.searchedFrom ?? availabilityContext?.searchedFrom ?? firstDate ?? kyivToday();
    delete args.afterDate;
    delete args.startDate;
    delete args.date;
  } else if (direction === "later") {
    args.direction = "later";
    const afterDate = cursor?.searchedThrough
      ?? availabilityContext?.searchedThrough
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
    if (request?.kind === "exact" && !pickedOfferedDay) {
      args.date = request.date;
    }
    delete args.afterDate;
    delete args.beforeDate;
    delete args.startDate;
  } else {
    // A nearest search is a new search from today. Stale model dates are unsafe.
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

  // Service duration is domain state, not an LLM-owned argument.
  if (serviceDurationMinutes != null) {
    args.durationMinutes = serviceDurationMinutes;
  }

  for (const key of ["date", "afterDate", "beforeDate", "startDate"] as const) {
    const value = args[key];
    if (typeof value === "string") {
      args[key] = alignToAnchors(value, [
        ...anchors,
        ...(cursor?.firstDate ? [cursor.firstDate] : []),
        ...(cursor?.lastDate ? [cursor.lastDate] : []),
        ...(cursor?.searchedFrom ? [cursor.searchedFrom] : []),
        ...(cursor?.searchedThrough ? [cursor.searchedThrough] : []),
      ]) as never;
    }
  }
  return args;
};

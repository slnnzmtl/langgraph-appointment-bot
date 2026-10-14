import {
  buildAvailabilitySlotsArgs,
  type BuildAvailabilitySlotsArgsInput,
} from "../../tools/availability-args.js";
import { kyivToday } from "../../tools/availability-slots.js";
import type { AvailabilitySlotsToolArgs } from "../../tools/availability-tools.js";
import {
  availabilityRequestFieldsFromDraft,
  bookingAvailabilityScope,
  bookingDraftCanPresentAvailability,
} from "../booking-draft.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import type { ClinicState } from "../state.js";
import {
  availabilitySlotsRanThisTurn,
  bookingDateAnchors,
  lastPatientText,
  matchAvailabilityDay,
  toolRanThisTurn,
} from "./shared.js";

export type RuntimeAvailabilityPurpose =
  | "reschedule_nearest"
  | "create_nearest"
  | "replacement_nearest"
  | "exact_date"
  | "page"
  | "create_revalidate"
  | "reschedule_revalidate";

export type RuntimeAvailabilityRequest = {
  args: AvailabilitySlotsToolArgs;
  purpose: RuntimeAvailabilityPurpose;
};

const slotsAlreadyThisTurn = (state: ClinicState): boolean =>
  toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots");

const pagedThisTurn = (state: ClinicState): boolean =>
  availabilitySlotsRanThisTurn(state.agentMessages ?? []);

const scheduleRequestFromState = (state: ClinicState) =>
  resolveBookingScheduleRequest(lastPatientText(state), kyivToday(), {
    availabilityContext: state.availabilityContext,
    availabilityCursor: state.availabilityCursor,
    selectedDate: state.bookingDraft?.selectedDate,
  });

const withDraftScope = (
  state: ClinicState,
  partial: Omit<
    BuildAvailabilitySlotsArgsInput,
    | "scope"
    | "availabilityContext"
    | "availabilityCursor"
    | "anchors"
    | "availabilityPagedThisTurn"
  >,
): AvailabilitySlotsToolArgs | null =>
  buildAvailabilitySlotsArgs({
    ...partial,
    scope: {
      ...bookingAvailabilityScope(state.bookingDraft),
      ...availabilityRequestFieldsFromDraft(state.bookingDraft),
    },
    availabilityContext: state.availabilityContext,
    availabilityCursor: state.availabilityCursor,
    anchors: bookingDateAnchors(state),
    availabilityPagedThisTurn: pagedThisTurn(state),
  });

/** Runtime-owned exact-day lookup when DATE has no trusted snapshot day yet. */
const nearestRescheduleRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null => {
  const draft = state.bookingDraft;
  if (
    draft?.mode !== "reschedule"
    || draft.rescheduleTarget == null
    || draft.selectedDate != null
    || slotsAlreadyThisTurn(state)
  ) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: "nearest",
    forceRefresh: true,
  });
  return args == null ? null : { args, purpose: "reschedule_nearest" };
};

/**
 * After service accept (first book or mid-booking service change) with no date
 * yet, runtime owns the nearest DATE search. Skip when a trusted snapshot is
 * already on the checkpoint unless a service-change notice forces a refresh.
 */
const createNearestRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null => {
  const draft = state.bookingDraft;
  if (
    draft?.mode !== "create"
    || draft.serviceAcceptance?.status !== "accepted"
    || draft.selectedDate != null
    || draft.selectedSlot != null
    || slotsAlreadyThisTurn(state)
  ) {
    return null;
  }
  if (state.pendingCancellationPurpose === "replacement") {
    return null;
  }
  const forceServiceChange = state.serviceChangeNotice != null;
  if (!forceServiceChange && state.availabilityContext != null) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: "nearest",
    forceRefresh: true,
  });
  return args == null ? null : { args, purpose: "create_nearest" };
};

/** After REPLACE cancel with an accepted service but no frozen create, offer dates. */
const replacementCancelNearestRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null => {
  const draft = state.bookingDraft;
  if (
    state.pendingCancellationPurpose !== "replacement"
    || draft?.mode !== "create"
    || draft.replacement != null
    || draft.serviceAcceptance?.status !== "accepted"
    || draft.selectedDate != null
    || draft.selectedSlot != null
    || !toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")
    || slotsAlreadyThisTurn(state)
  ) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: "nearest",
    forceRefresh: true,
  });
  return args == null ? null : { args, purpose: "replacement_nearest" };
};

/** Exact-day refresh when the draft date needs a fresh CRM lookup. */
const exactDateFromDraftRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null => {
  const human = lastPatientText(state);
  const request = scheduleRequestFromState(state);
  const selectedDate = state.bookingDraft?.selectedDate;
  if (selectedDate == null || slotsAlreadyThisTurn(state)) {
    return null;
  }
  const explicitDateRequest = request?.kind === "exact" && request.date === selectedDate;
  const pickedOfferedDay = matchAvailabilityDay(
    human,
    state.availabilityContext?.days ?? [],
  ) != null;
  const dateIntentRequiresFreshLookup = explicitDateRequest && !pickedOfferedDay;
  const pendingRequestedTime = state.bookingDraft?.requestedTime?.status === "pending";
  if (!dateIntentRequiresFreshLookup && !pendingRequestedTime) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: "exact",
    date: selectedDate,
    forceRefresh: true,
  });
  return args == null ? null : { args, purpose: "exact_date" };
};

/**
 * earlier / later / «Інша дата» paging from patient schedule intent, grounded
 * in the cursor and one-page-per-turn protection.
 */
const pagingRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null => {
  if (!bookingDraftCanPresentAvailability(state.bookingDraft)) {
    return null;
  }
  if (slotsAlreadyThisTurn(state) || pagedThisTurn(state)) {
    return null;
  }
  const request = scheduleRequestFromState(state);
  if (request?.kind !== "earlier" && request?.kind !== "later") {
    return null;
  }
  // Need a window to page from — bare later with no snapshot is create-nearest.
  if (
    state.availabilityContext == null
    && state.availabilityCursor == null
  ) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: request.kind,
  });
  return args == null ? null : { args, purpose: "page" };
};

/** Fresh exact-day revalidation before create_meeting or reschedule_meeting. */
export const exactRevalidateRequest = (
  state: ClinicState,
  purpose: "create_revalidate" | "reschedule_revalidate",
): RuntimeAvailabilityRequest | null => {
  const selectedDate = state.bookingDraft?.selectedDate;
  if (selectedDate == null || slotsAlreadyThisTurn(state)) {
    return null;
  }
  const args = withDraftScope(state, {
    direction: "exact",
    date: selectedDate,
    forceRefresh: true,
  });
  return args == null ? null : { args, purpose };
};

/**
 * Next runtime-owned availability presentation for this turn (excluding
 * create/reschedule revalidation, which the command resolver owns when a
 * mutation is ready).
 */
export const resolveRuntimeAvailabilityRequest = (
  state: ClinicState,
): RuntimeAvailabilityRequest | null =>
  nearestRescheduleRequest(state)
  ?? createNearestRequest(state)
  ?? replacementCancelNearestRequest(state)
  ?? exactDateFromDraftRequest(state)
  ?? pagingRequest(state);

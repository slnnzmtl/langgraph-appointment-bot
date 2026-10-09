import type { BaseMessage } from "@langchain/core/messages";

import { labelIdFor } from "../../shared/message-content.js";
import { availabilityCursorFromContext } from "../../tools/availability-tools.js";
import { reduceBookingDraft, type BookingDraft } from "../booking-draft.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
} from "../booking-session.js";
import { stripToolNoiseFromMessages } from "../supervisor-history.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import type { AgentPrefetchResult } from "../types.js";
import {
  classifyCancelTap,
  isGreetingOrMainMenuLine,
  lastHumanLineFromMessages,
  lastHumanTextFromMessages,
  type CancelTap,
} from "./routing-predicates.js";
import { isVisitStatusSignal } from "./visit-status.js";

export const PREFETCH_TTL_MS = 5 * 60 * 1000;

export const isPrefetchExpired = (
  fetchedAt: number | null | undefined,
  ttlMs: number,
  now = Date.now(),
): boolean => fetchedAt == null || now - fetchedAt >= ttlMs;

export type SupervisorTurnContext = {
  state: ClinicState;
  history: BaseMessage[];
  lastHumanLine: string;
  lastHumanText: string;
  visitStatusIntent: boolean;
  cancelTap: CancelTap | null;
  closeBookingSession: boolean;
  prefetchReused: boolean;
  contactContext: ClinicState["contactContext"];
  bookingContext: ClinicState["bookingContext"];
  prefetchUpdate: ClinicStateUpdate;
  workingDraft: BookingDraft | null;
};

type PrefetchFlags = {
  closeBookingSession: boolean;
  resetBookingLadder: boolean;
  clearOnVisitStatusFailure: boolean;
};

const runPrefetch = async (
  prefetch: () => Promise<AgentPrefetchResult>,
  state: ClinicState,
  flags: PrefetchFlags,
): Promise<{
  contactContext: ClinicState["contactContext"];
  bookingContext: ClinicState["bookingContext"];
  update: ClinicStateUpdate;
  ok: boolean;
}> => {
  try {
    const prefetched = await prefetch();
    return {
      contactContext: prefetched.contactContext,
      bookingContext: prefetched.bookingContext,
      ok: true,
      update: {
        ...prefetched,
        prefetchDirty: false,
        prefetchFetchedAt: Date.now(),
        availabilityContext: null,
        availabilityCursor: flags.resetBookingLadder
          ? null
          : state.availabilityCursor ?? availabilityCursorFromContext(state.availabilityContext),
        ...(flags.closeBookingSession ? closedBookingSessionUpdate() : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[clinic-supervisor] prefetch failed:", message);
    if (!flags.clearOnVisitStatusFailure) {
      return {
        contactContext: state.contactContext,
        bookingContext: state.bookingContext,
        ok: false,
        update: flags.closeBookingSession ? closedBookingSessionUpdate() : {},
      };
    }
    return {
      contactContext: null,
      bookingContext: null,
      ok: false,
      update: {
        bookingContext: null,
        contactContext: null,
        prefetchDirty: true,
        ...(flags.closeBookingSession ? closedBookingSessionUpdate() : {}),
      },
    };
  }
};

export const buildSupervisorTurnContext = async (
  state: ClinicState,
  options: {
    prefetch?: () => Promise<AgentPrefetchResult>;
    prefetchTtlMs?: number;
  },
): Promise<SupervisorTurnContext> => {
  const history = stripToolNoiseFromMessages(state.messages);
  const ttlMs = options.prefetchTtlMs ?? PREFETCH_TTL_MS;
  const lastHumanLine = lastHumanLineFromMessages(state.messages);
  const lastHumanText = lastHumanTextFromMessages(state.messages);
  const visitStatusIntent = isVisitStatusSignal(lastHumanText);
  const cancelTap = classifyCancelTap(state, lastHumanLine);
  const closeBookingSession =
    isGreetingOrMainMenuLine(lastHumanLine)
    || visitStatusIntent
    || cancelTap === "abandon";

  let contactContext = state.contactContext;
  let bookingContext = state.bookingContext;
  let prefetchUpdate: ClinicStateUpdate = closeBookingSession
    ? closedBookingSessionUpdate()
    : {};
  let workingDraft = state.bookingDraft ?? null;
  const openInteractionClaimsInput = state.pendingInteraction != null
    && interpretInteractionReply(state.pendingInteraction, lastHumanText).kind === "choice";
  if (
    !closeBookingSession
    && workingDraft?.pendingCommand?.action === "cancel"
    && cancelTap == null
    && !openInteractionClaimsInput
  ) {
    workingDraft = reduceBookingDraft(workingDraft, { type: "command_cleared" });
    prefetchUpdate = {
      ...prefetchUpdate,
      bookingDraft: workingDraft,
    };
  }

  const forcePrefetch = visitStatusIntent
    || labelIdFor(lastHumanLine) === "mainMenu"
    || cancelTap != null;
  const reusePrefetch =
    state.contactContext != null
    && !state.prefetchDirty
    && !forcePrefetch
    && !isPrefetchExpired(state.prefetchFetchedAt, ttlMs);

  if (options.prefetch && !reusePrefetch) {
    const result = await runPrefetch(options.prefetch, state, {
      closeBookingSession,
      resetBookingLadder:
        isGreetingOrMainMenuLine(lastHumanLine)
        || visitStatusIntent
        || (cancelTap != null && state.bookingDraft?.selectedSlot == null),
      clearOnVisitStatusFailure: visitStatusIntent,
    });
    contactContext = result.contactContext;
    bookingContext = result.bookingContext;
    if (result.ok || visitStatusIntent) {
      prefetchUpdate = result.update;
    }
  }

  return {
    state,
    history,
    lastHumanLine,
    lastHumanText,
    visitStatusIntent,
    cancelTap,
    closeBookingSession,
    prefetchReused: reusePrefetch,
    contactContext,
    bookingContext,
    prefetchUpdate,
    workingDraft,
  };
};

/** Force a CRM refetch when model visit_status used a reused prefetch. */
export const refetchForVisitStatus = async (
  ctx: SupervisorTurnContext,
  prefetch: (() => Promise<AgentPrefetchResult>) | undefined,
): Promise<SupervisorTurnContext> => {
  if (!ctx.prefetchReused || prefetch == null) {
    return ctx;
  }
  const result = await runPrefetch(prefetch, ctx.state, {
    closeBookingSession: ctx.closeBookingSession,
    resetBookingLadder: true,
    clearOnVisitStatusFailure: true,
  });
  return {
    ...ctx,
    contactContext: result.contactContext,
    bookingContext: result.bookingContext,
    prefetchReused: false,
    prefetchUpdate: {
      ...ctx.prefetchUpdate,
      ...result.update,
    },
  };
};

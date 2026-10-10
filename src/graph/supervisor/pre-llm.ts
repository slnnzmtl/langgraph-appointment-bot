import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
} from "../booking-session.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "../types.js";
import type { SupervisorTurnContext } from "./context.js";
import type { RouteOutcome } from "./telemetry.js";
import {
  isPendingRescheduleSelection,
  shouldRouteProcedureBrowseToFaq,
  stickyContinueAgentId,
} from "./routing-predicates.js";
import {
  seedVisitMutation,
  visitMutationActionForLabel,
} from "./visit-change-seed.js";
import { abandonReply, applyVisitSelectChoice } from "./visit-select.js";
import { buildVisitStatusMenuUpdate } from "./visit-status.js";

type PreLlmRule = (ctx: SupervisorTurnContext) => RouteOutcome | null;

const pendingRescheduleDate: PreLlmRule = (ctx) => {
  if (!isPendingRescheduleSelection(ctx.state, ctx.lastHumanText, ctx.bookingContext)) {
    return null;
  }
  const seed = seedVisitMutation("reschedule", ctx.bookingContext, ctx.workingDraft);
  return {
    path: "pending_reschedule",
    update: {
      next: BOOKING_AGENT_ID,
      ...ctx.prefetchUpdate,
      ...seed.update,
      availabilityContext: null,
      availabilityCursor: null,
    },
    draftDiscarded: seed.draftDiscarded,
  };
};

const abandonBareCancel: PreLlmRule = (ctx) => {
  if (ctx.cancelTap !== "abandon") {
    return null;
  }
  return {
    path: "abandon",
    update: abandonReply(ctx.prefetchUpdate, ctx.bookingContext),
  };
};

const visitStatusSignal: PreLlmRule = (ctx) => {
  if (!ctx.visitStatusIntent) {
    return null;
  }
  return {
    path: "status_pre_llm",
    update: buildVisitStatusMenuUpdate(
      ctx.prefetchUpdate,
      ctx.state,
      ctx.bookingContext,
    ),
  };
};

const openVisitMenu: PreLlmRule = (ctx) => {
  const openVisitSelect =
    ctx.state.pendingInteraction?.kind === "visit_select"
      ? ctx.state.pendingInteraction
      : null;
  if (openVisitSelect == null) {
    return null;
  }
  const match = interpretInteractionReply(openVisitSelect, ctx.lastHumanText);
  if (match.kind !== "choice") {
    return null;
  }
  const visitSelectUpdate = applyVisitSelectChoice(
    openVisitSelect,
    match.choiceId,
    ctx.prefetchUpdate,
    ctx.workingDraft,
  );
  if (visitSelectUpdate == null) {
    return null;
  }
  return { path: "chip", update: visitSelectUpdate };
};

const sticky: PreLlmRule = (ctx) => {
  // Prefer the refreshed prefetch + working draft so visit-cancel sticky
  // sees meetings loaded this turn.
  const stickyState = {
    ...ctx.state,
    bookingContext: ctx.bookingContext,
    bookingDraft: ctx.workingDraft,
  };
  const stickyNext = stickyContinueAgentId(stickyState);
  if (stickyNext == null) {
    return null;
  }
  const seed = seedVisitMutation(
    visitMutationActionForLabel(ctx.lastHumanLine),
    ctx.bookingContext,
    ctx.workingDraft,
  );
  return {
    path: "sticky",
    update: {
      next: stickyNext,
      lastHandoff: null,
      ...ctx.prefetchUpdate,
      ...seed.update,
    },
    draftDiscarded: seed.draftDiscarded,
  };
};

const faqPredicates: PreLlmRule = (ctx) => {
  // Only «Обрати іншу процедуру» — always leave the service_confirm offer.
  if (!shouldRouteProcedureBrowseToFaq(ctx.state)) {
    return null;
  }
  return {
    path: "faq_predicate",
    update: {
      next: FAQ_AGENT_ID,
      lastHandoff: null,
      ...ctx.prefetchUpdate,
      availabilityContext: null,
      availabilityCursor: null,
      ...closedBookingSessionUpdate(),
    },
  };
};

/** Ordered pre-LLM rules — first match wins. */
export const PRE_LLM_RULES: readonly PreLlmRule[] = [
  pendingRescheduleDate,
  abandonBareCancel,
  visitStatusSignal,
  openVisitMenu,
  sticky,
  faqPredicates,
];

export const resolvePreLlmRoute = (ctx: SupervisorTurnContext): RouteOutcome | null => {
  for (const rule of PRE_LLM_RULES) {
    const outcome = rule(ctx);
    if (outcome != null) {
      return outcome;
    }
  }
  return null;
};

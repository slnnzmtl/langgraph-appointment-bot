import { isSupervisorOwnedLabel } from "../../shared/message-content.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
  openVisitMeetingInteraction,
} from "../booking-session.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking-interaction-render.js";
import type { ClinicRoutingDecision } from "../routing.js";
import { BOOKING_AGENT_ID, FINISH_ROUTE } from "../types.js";
import type { SupervisorTurnContext } from "./context.js";
import { specialistForSupervisorIntent } from "./intent-handlers.js";
import { supervisorOwnedChoiceId } from "./open-interaction.js";
import { resolveRoutingDecision } from "./resolve-routing.js";
import { isGreetingOrMainMenuLine } from "./routing-predicates.js";
import type { RouteOutcome, SupervisorRoutingPath } from "./telemetry.js";
import {
  seedVisitMutation,
  visitMutationActionForIntent,
} from "./visit-change-seed.js";
import {
  abandonReply,
  applyVisitSelectChoice,
  supervisorFinishReply,
} from "./visit-select.js";
import {
  buildVisitStatusMenuUpdate,
  visitSelectMeetingsFromContext,
} from "./visit-status.js";

type PostLlmRule = (
  ctx: SupervisorTurnContext,
  decision: ClinicRoutingDecision,
  enabledIds: Set<string>,
) => RouteOutcome | null;

const modelChoice: PostLlmRule = (ctx, decision) => {
  const choice = supervisorOwnedChoiceId(ctx.state.pendingInteraction, decision.choiceId);
  if (choice == null) {
    return null;
  }
  const choiceRouted = applyVisitSelectChoice(
    choice.interaction,
    choice.choiceId,
    ctx.prefetchUpdate,
    ctx.workingDraft,
  );
  if (choiceRouted == null) {
    return null;
  }
  return {
    path: "llm_choice",
    update: choiceRouted,
    choiceAccepted: true,
  };
};

const modelAbandon: PostLlmRule = (ctx, decision) => {
  if (decision.intent !== "abandon_booking") {
    return null;
  }
  return {
    path: "llm_abandon",
    update: abandonReply(ctx.prefetchUpdate, ctx.bookingContext),
  };
};

const modelStatus: PostLlmRule = (ctx, decision) => {
  if (decision.intent !== "visit_status") {
    return null;
  }
  return {
    path: "llm_status",
    update: buildVisitStatusMenuUpdate(
      ctx.prefetchUpdate,
      ctx.state,
      ctx.bookingContext,
    ),
  };
};

const multiVisitPicker: PostLlmRule = (ctx, decision) => {
  const mutationAction = visitMutationActionForIntent(decision.intent);
  const meetingsForPicker = visitSelectMeetingsFromContext(ctx.bookingContext);
  if (mutationAction == null || meetingsForPicker.length <= 1) {
    return null;
  }
  const picker = openVisitMeetingInteraction(mutationAction, meetingsForPicker);
  return {
    path: "llm_picker",
    update: supervisorFinishReply(
      ctx.prefetchUpdate,
      String(renderBookingInteractionMessage(picker).content),
      replyButtonsForInteraction(picker),
      picker,
    ),
  };
};

const intentOverride: PostLlmRule = (ctx, decision, enabledIds) => {
  // «Головне меню» must stay on FINISH with the default keyboard even when the
  // model returns next=booking / intent=book from nearby booking history.
  const mainMenuLine = isGreetingOrMainMenuLine(ctx.lastHumanLine);
  const effectiveDecision: ClinicRoutingDecision = mainMenuLine
    ? (() => {
        const { intent: _ignored, ...rest } = decision;
        return { ...rest, next: FINISH_ROUTE };
      })()
    : decision;
  let routed = resolveRoutingDecision(
    effectiveDecision,
    ctx.state,
    enabledIds,
    ctx.bookingContext,
  );
  const intentSpecialist = specialistForSupervisorIntent(effectiveDecision.intent);
  let path: SupervisorRoutingPath = "llm";
  if (
    !mainMenuLine
    && intentSpecialist != null
    && routed.next !== intentSpecialist
    && enabledIds.has(intentSpecialist)
  ) {
    routed = { next: intentSpecialist, lastHandoff: null };
    path = "llm_intent_override";
  }

  const mutationAction = visitMutationActionForIntent(effectiveDecision.intent);
  const seed = routed.next === BOOKING_AGENT_ID
    ? seedVisitMutation(mutationAction, ctx.bookingContext, ctx.workingDraft)
    : { update: {}, draftDiscarded: false };

  const keepAvailability =
    ctx.state.lastHandoff?.agentId === BOOKING_AGENT_ID
    && routed.next === BOOKING_AGENT_ID
    && !isSupervisorOwnedLabel(ctx.lastHumanLine);
  const chooseOtherOnOpenOffer =
    ctx.state.pendingInteraction?.kind === "service_confirm"
    && (() => {
      const match = interpretInteractionReply(
        ctx.state.pendingInteraction,
        ctx.lastHumanText,
      );
      return match.kind === "choice" && match.choiceId === "choose_other";
    })();
  // Only main menu or choose_other while the offer keyboard is open.
  const abandonDraft = mainMenuLine || chooseOtherOnOpenOffer;

  const outcome: RouteOutcome = {
    path,
    update: {
      ...routed,
      ...ctx.prefetchUpdate,
      ...seed.update,
      ...(abandonDraft ? closedBookingSessionUpdate() : {}),
      ...(keepAvailability
        ? {}
        : {
          availabilityContext: null,
          availabilityCursor: null,
        }),
    },
    draftDiscarded: seed.draftDiscarded,
  };
  if (decision.choiceId != null) {
    outcome.choiceAccepted = false;
  }
  return outcome;
};

/** Ordered post-LLM rules — first match wins; intentOverride is the default. */
export const POST_LLM_RULES: readonly PostLlmRule[] = [
  modelChoice,
  modelAbandon,
  modelStatus,
  multiVisitPicker,
  intentOverride,
];

export const applyModelDecision = (
  ctx: SupervisorTurnContext,
  decision: ClinicRoutingDecision,
  enabledIds: Set<string>,
): RouteOutcome => {
  for (const rule of POST_LLM_RULES) {
    const outcome = rule(ctx, decision, enabledIds);
    if (outcome != null) {
      return outcome;
    }
  }
  return {
    path: "llm",
    update: {
      next: FINISH_ROUTE,
      ...ctx.prefetchUpdate,
    },
  };
};

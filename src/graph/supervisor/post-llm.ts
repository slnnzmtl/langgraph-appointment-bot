import { isSupervisorOwnedLabel } from "../../shared/message-content.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
  interactionChoiceEquals,
  openVisitMeetingInteraction,
} from "../booking/booking-session.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking/booking-interaction-render.js";
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

/** First: Main menu FINISH from resolveRoutingDecision, not later intent rules. */
const modelMainMenu: PostLlmRule = (ctx, decision, enabledIds) => {
  if (!isGreetingOrMainMenuLine(ctx.lastHumanLine)) {
    return null;
  }
  const outcome: RouteOutcome = {
    path: "main_menu",
    update: {
      ...resolveRoutingDecision(
        { next: FINISH_ROUTE },
        ctx.state,
        enabledIds,
        ctx.bookingContext,
      ),
      ...ctx.prefetchUpdate,
      supervisorIntent: null,
      availabilityContext: null,
      availabilityCursor: null,
    },
  };
  if (decision.choiceId != null) {
    outcome.choiceAccepted = false;
  }
  return outcome;
};

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
  let routed = resolveRoutingDecision(
    decision,
    ctx.state,
    enabledIds,
    ctx.bookingContext,
  );
  const intentSpecialist = specialistForSupervisorIntent(decision.intent);
  let path: SupervisorRoutingPath = "llm";
  if (
    intentSpecialist != null
    && routed.next !== intentSpecialist
    && enabledIds.has(intentSpecialist)
  ) {
    routed = { next: intentSpecialist, lastHandoff: null };
    path = "llm_intent_override";
  }

  const mutationAction = visitMutationActionForIntent(decision.intent);
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
      return match.kind === "choice" && interactionChoiceEquals(match.choiceId, "choose_other");
    })();
  const abandonDraft = chooseOtherOnOpenOffer;

  const outcome: RouteOutcome = {
    path,
    update: {
      ...routed,
      ...ctx.prefetchUpdate,
      ...seed.update,
      // One-turn gate for FAQ prepare catalog open — not a phrase matcher.
      supervisorIntent:
        decision.intent === "named_procedure" ? "named_procedure" : null,
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
  modelMainMenu,
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

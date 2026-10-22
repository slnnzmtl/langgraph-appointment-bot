import type { InterpretBookingTurn } from "../agent-loop/booking-turn-interpreter.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import { nextBookingRequirement } from "../booking-domain/requirement.js";
import { askDecisionFromPendingView } from "../booking-domain/decide.js";
import { replyChoicesFromCard } from "../agent-loop/booking-card-choices.js";
import {
  hasOpenBookingSession,
  routeUnderstoodTurn,
} from "../receptionist-route.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  FINISH_ROUTE,
  type AgentPrefetchResult,
  type ClinicSpecialists,
  type ILLMConnector,
} from "../types.js";
import type { ServicesContext } from "../../tools/service-tools.js";
import { kyivToday } from "../../tools/availability-slots.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  buildSupervisorTurnContext,
  refetchForVisitStatus,
  type SupervisorTurnContext,
  PREFETCH_TTL_MS,
} from "./context.js";
import {
  emitSupervisorRoutingDecision,
  type RouteOutcome,
} from "./telemetry.js";
import {
  applyVisitSelectChoice,
  mainMenuReply,
} from "./visit-select.js";
import { buildVisitStatusMenuUpdate } from "./visit-status.js";
import { seedVisitMutation } from "./visit-change-seed.js";
import { isPendingRescheduleSelection } from "./routing-predicates.js";
import {
  MAIN_MENU_GREETING_UK,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import type { InteractionLocale } from "../booking-interaction-render.js";
import type { ContextCacheManager } from "@personal-assistant/llm-gemini";

export type SupervisorContextCacheOptions = {
  manager: ContextCacheManager;
  apiKey: string;
  modelName: string;
  displayName?: string;
};

export type CreateClinicSupervisorNodeOptions = {
  specialists: ClinicSpecialists;
  supervisorLlm: ILLMConnector;
  loadSupervisorPrompt: () => string;
  buildSupervisorDynamicContext?: () => string;
  prefetch?: () => Promise<AgentPrefetchResult>;
  prefetchTtlMs?: number;
  /** Lazy CRM catalog (unused after ingress cutover; kept for call-site compat). */
  loadServices?: () => Promise<ServicesContext | null>;
  contextCache?: SupervisorContextCacheOptions;
  /** Ingress turn interpreter — one call per normal turn. */
  interpretTurn?: InterpretBookingTurn;
};

export { PREFETCH_TTL_MS };

/** Prefer English when the latest human line is mostly Latin letters. */
const detectPatientLocaleInline = (state: ClinicState): InteractionLocale => {
  const messages = state.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?._getType?.() !== "human") {
      continue;
    }
    const text = extractMessageTextContent(message.content).trim();
    if (text.length === 0) {
      break;
    }
    const letters = text.replace(/[^A-Za-zА-Яа-яЁёІіЇїЄєҐґ]/gu, "");
    if (letters.length === 0) {
      return "uk";
    }
    const latin = (letters.match(/[A-Za-z]/g) ?? []).length;
    return latin / letters.length >= 0.6 ? "en" : "uk";
  }
  return "uk";
};

const finalize = (
  ctx: SupervisorTurnContext,
  outcome: RouteOutcome,
): ClinicStateUpdate => {
  emitSupervisorRoutingDecision({
    path: outcome.path,
    ...(outcome.choiceAccepted != null ? { choiceAccepted: outcome.choiceAccepted } : {}),
    regexStatusSignal: ctx.visitStatusIntent,
    ...(typeof outcome.update.next === "string" ? { next: outcome.update.next } : {}),
    ...(outcome.draftDiscarded != null ? { draftDiscarded: outcome.draftDiscarded } : {}),
  });
  return outcome.update;
};

/**
 * Prefetch → interpret once → routeUnderstoodTurn → specialist or FINISH.
 * No pre-LLM sticky table and no supervisor routing LLM.
 */
export const createClinicSupervisorNode = (options: CreateClinicSupervisorNodeOptions) => {
  void options.specialists;
  void options.supervisorLlm;
  void options.loadSupervisorPrompt;
  void options.buildSupervisorDynamicContext;
  void options.loadServices;
  void options.contextCache;

  return async (state: ClinicState): Promise<ClinicStateUpdate> => {
    let ctx = await buildSupervisorTurnContext(state, {
      ...(options.prefetch != null ? { prefetch: options.prefetch } : {}),
      ...(options.prefetchTtlMs != null ? { prefetchTtlMs: options.prefetchTtlMs } : {}),
    });

    const activeView = askDecisionFromPendingView(ctx.workingDraft);
    const cardChoices = replyChoicesFromCard(activeView?.card ?? null);
    // Visit-select and FAQ catalog chips are not on the kernel card — use the open interaction.
    const interaction = state.pendingInteraction;
    const interactionChoices =
      interaction != null
      && (
        interaction.kind === "visit_select"
        || (
          interaction.kind === "service_candidate"
          && (interaction.owner === "faq" || interaction.owner === "booking")
        )
      )
        ? interaction.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
        }))
        : [];
    const offeredChoices = cardChoices.length > 0 ? cardChoices : interactionChoices;
    const offeredFromCard = offeredChoices.map((choice) => choice.id);
    const offeredLabels = offeredChoices.map((choice) => choice.label);
    const openContact =
      interaction?.kind === "contact_field" ? interaction.field : undefined;

    const interpretInput = {
      rawText: ctx.lastHumanText,
      ...(ctx.state.inboundChoiceId != null
        ? { callbackChoiceId: ctx.state.inboundChoiceId }
        : {}),
      ...(offeredFromCard.length > 0 ? { offeredChoiceIds: offeredFromCard } : {}),
      ...(offeredLabels.length > 0 ? { offeredChoiceLabels: offeredLabels } : {}),
      awaitingNote: ctx.workingDraft?.note.status === "awaiting"
        || ctx.workingDraft?.phase === "note",
      ...(openContact != null ? { awaitingContactField: openContact } : {}),
      awaitingServiceConfirm: activeView?.card?.kind === "service_confirm",
      activeRequirement: nextBookingRequirement(ctx.workingDraft, {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: ctx.state.availabilityContext != null,
      }),
      kyivDate: kyivToday(),
      locale: detectPatientLocaleInline(state),
    };

    const interpretTurn = options.interpretTurn;
    const patch = interpretTurn != null
      ? await interpretTurn(interpretInput)
      : interpretBookingTurnDeterministic(interpretInput);

    // Open visit_select action/meeting chips finish in the supervisor (FINISH UI).
    const visitSelectChoiceId =
      interaction?.kind === "visit_select"
      && (interaction.stage === "action" || interaction.stage === "meeting")
        ? (
          patch.choice?.choiceId
          ?? (patch.controlIntent?.kind === "hitl_no" ? "decline" : undefined)
        )
        : undefined;
    if (interaction?.kind === "visit_select" && visitSelectChoiceId != null) {
      const visitSelectUpdate = applyVisitSelectChoice(
        interaction,
        visitSelectChoiceId,
        ctx.prefetchUpdate,
        ctx.workingDraft,
      );
      if (visitSelectUpdate != null) {
        return finalize(ctx, {
          path: "chip",
          update: { ...visitSelectUpdate, understoodTurn: null },
        });
      }
    }

    // Single-visit action menu + calendar/clock free text → seed reschedule.
    if (
      interaction?.kind === "visit_select"
      && isPendingRescheduleSelection(
        ctx.state,
        ctx.lastHumanText,
        ctx.bookingContext,
      )
    ) {
      const seed = seedVisitMutation(
        "reschedule",
        ctx.bookingContext,
        ctx.workingDraft,
      );
      return finalize(ctx, {
        path: "chip",
        update: {
          next: BOOKING_AGENT_ID,
          lastHandoff: null,
          supervisorIntent: null,
          ...ctx.prefetchUpdate,
          ...seed.update,
          understoodTurn: Object.keys(patch).length > 0 ? patch : {},
        },
        draftDiscarded: seed.draftDiscarded,
      });
    }

    let route = routeUnderstoodTurn(patch, ctx.workingDraft);

    // Open service_candidate picker: chips + free-text stay on catalog.
    // Unique remaining CRM id → booking catalog_service; do not REPLACE mid-browse.
    if (
      interaction?.kind === "service_candidate"
      && (interaction.owner === "faq" || interaction.owner === "booking")
      && patch.scheduleIntent == null
      && patch.controlIntent == null
    ) {
      if (patch.choice != null && patch.serviceIntent == null) {
        const choice = interaction.choices.find(
          (entry) => entry.id === patch.choice!.choiceId,
        );
        const remainingIds =
          choice?.serviceIds != null && choice.serviceIds.length > 0
            ? choice.serviceIds
            : [patch.choice.choiceId];
        if (remainingIds.length === 1) {
          const serviceId = remainingIds[0]!;
          const row = (state.servicesContext?.list ?? []).find(
            (service) => service.id === serviceId,
          );
          route = {
            kind: "booking",
            patch: {
              serviceIntent: {
                kind: "catalog_service",
                serviceId,
                ...(row?.name != null ? { serviceName: row.name } : {}),
              },
            },
          };
        } else if (!hasOpenBookingSession(ctx.workingDraft)) {
          route = { kind: "faq_capability", patch };
        }
      } else if (
        !hasOpenBookingSession(ctx.workingDraft)
        && (
          patch.serviceIntent?.kind === "named_procedure"
          || patch.serviceIntent?.kind === "catalog_browse"
          || patch.idleFaq != null
          || patch.faqTopic != null
          || patch.informationalQuestion != null
        )
      ) {
        route = { kind: "faq_capability", patch };
      }
    }

    if (route.kind === "visit_status") {
      ctx = await refetchForVisitStatus(ctx, options.prefetch);
      return finalize(ctx, {
        path: "llm_status",
        update: {
          ...buildVisitStatusMenuUpdate(
            ctx.prefetchUpdate,
            ctx.state,
            ctx.bookingContext,
          ),
          understoodTurn: null,
        },
      });
    }
    if (route.kind === "main_menu") {
      return finalize(ctx, {
        path: "main_menu",
        update: mainMenuReply(
          ctx.prefetchUpdate,
          ctx.bookingContext,
          ctx.contactContext,
        ),
      });
    }
    if (route.kind === "greeting" || route.kind === "help") {
      const hasVisit = (ctx.bookingContext?.meetings.length ?? 0) > 0;
      return finalize(ctx, {
        path: route.kind === "help" ? "llm" : "main_menu",
        update: {
          next: FINISH_ROUTE,
          ...ctx.prefetchUpdate,
          lastHandoff: {
            agentId: FINISH_ROUTE,
            agentName: "supervisor",
            status: "ok",
            replyText: MAIN_MENU_GREETING_UK,
            replyButtons: [...defaultMenuLabels(hasVisit)],
          },
          understoodTurn: null,
        },
      });
    }
    if (route.kind === "booking") {
      const control = route.patch.controlIntent?.kind;
      const seed = control === "visit_reschedule"
        ? seedVisitMutation("reschedule", ctx.bookingContext, ctx.workingDraft)
        : control === "visit_cancel"
          ? seedVisitMutation("cancel", ctx.bookingContext, ctx.workingDraft)
          : { update: {}, draftDiscarded: false };
      return finalize(ctx, {
        path: "llm",
        update: {
          next: BOOKING_AGENT_ID,
          lastHandoff: null,
          supervisorIntent: null,
          ...ctx.prefetchUpdate,
          ...seed.update,
          understoodTurn: route.patch,
        },
        draftDiscarded: seed.draftDiscarded,
      });
    }
    if (route.kind === "faq_capability") {
      return finalize(ctx, {
        path: "llm",
        update: {
          next: FAQ_AGENT_ID,
          lastHandoff: null,
          supervisorIntent: null,
          ...ctx.prefetchUpdate,
          understoodTurn: route.patch,
        },
      });
    }

    // clarification / empty — no routing LLM. Idle greeting; open session re-asks.
    if (hasOpenBookingSession(ctx.workingDraft)) {
      return finalize(ctx, {
        path: "llm",
        update: {
          next: BOOKING_AGENT_ID,
          lastHandoff: null,
          supervisorIntent: null,
          ...ctx.prefetchUpdate,
          understoodTurn: {},
        },
      });
    }
    const hasVisit = (ctx.bookingContext?.meetings.length ?? 0) > 0;
    return finalize(ctx, {
      path: "main_menu",
      update: {
        next: FINISH_ROUTE,
        ...ctx.prefetchUpdate,
        lastHandoff: {
          agentId: FINISH_ROUTE,
          agentName: "supervisor",
          status: "ok",
          replyText: MAIN_MENU_GREETING_UK,
          replyButtons: [...defaultMenuLabels(hasVisit)],
        },
        understoodTurn: null,
      },
    });
  };
};

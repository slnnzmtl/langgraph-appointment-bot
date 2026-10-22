import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { trackEvent } from "../../../analytics/track.js";
import { extractFaqCatalogAction } from "../../../shared/message-content.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import {
  openCatalogFromFreeText,
  openRootFaqCatalog,
} from "../../booking-entry-policy.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../../booking-interaction-render.js";
import {
  faqCatalogIntroFromModel,
  faqCatalogPreserveModelAnswer,
  renderFaqCatalogReply,
} from "../../faq-catalog.js";
import {
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking-session.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { BOOKING_AGENT_ID } from "../../types.js";
import {
  classifyMeetingMutationToolMessage,
  ensureServicesContext,
} from "../protocol/index.js";
import { faqHighlightChoice } from "../../faq-highlight.js";
import {
  emptyFinalizeReply,
  faqCatalogChipReply,
  type FinalizeReply,
} from "./shared.js";

const classifyMeetingMutationCommittedCancel = (
  messages: BaseMessage[] | undefined,
): boolean =>
  (messages ?? []).some(
    (message) =>
      message instanceof ToolMessage
      && message.name === "cancel_meeting"
      && classifyMeetingMutationToolMessage(message) === "committed",
  );

export type FinalizeFaqOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** No-AI FAQ: prepare opened catalog chips without an LLM turn. */
export const tryFaqNoAiFinalize = (
  state: ClinicState,
): FinalizeReply | null => {
  if (state.pendingInteraction == null) {
    return null;
  }
  const interaction = state.pendingInteraction;
  if (
    interaction.kind === "service_candidate"
    && interaction.owner === "faq"
  ) {
    const chips = faqCatalogChipReply(
      interaction,
      state.servicesContext?.list ?? [],
    );
    const replaceCancelAck =
      interaction.consultationDeclined === true
      && classifyMeetingMutationCommittedCancel(state.agentMessages)
        ? "Запис скасовано.\n\n"
        : "";
    return {
      ...emptyFinalizeReply("ok"),
      replyText: `${replaceCancelAck}${chips.replyText}`,
      replyButtons: chips.replyButtons,
      replySource: "runtime",
      patch: {
        supervisorIntent: null,
        pendingInteraction: interaction,
      },
    };
  }
  return null;
};

export type FaqCatalogAiResult = {
  reply: FinalizeReply;
  serviceOfferUpdate: ClinicStateUpdate;
};

/** FAQ AI-path catalog: open_catalog / keep / close — never writes bookingDraft. */
export const applyFaqCatalogAiFinalize = async (
  state: ClinicState,
  reply: FinalizeReply,
  rawText: string,
  options?: FinalizeFaqOptions,
): Promise<FaqCatalogAiResult> => {
  const {
    action: faqCatalogAction,
    query: faqCatalogQuery,
  } = extractFaqCatalogAction(rawText);

  let next = { ...reply };
  let serviceOfferUpdate: ClinicStateUpdate = {};

  const openFaqCatalog =
    state.pendingInteraction?.kind === "service_candidate"
    && state.pendingInteraction.owner === "faq";
  const openCatalogDetour = state.pendingInteraction?.kind === "catalog_detour";

  if (faqCatalogAction === "open_catalog") {
    const ensured = await ensureServicesContext(
      state.servicesContext,
      options?.loadServices,
    );
    const services = ensured.list;
    const servicesUpdate: ClinicStateUpdate =
      ensured.loaded != null ? { servicesContext: ensured.loaded } : {};
    const query = (faqCatalogQuery ?? "").trim();
    const session = query.length > 0
      ? await openCatalogFromFreeText({
          text: query,
          services,
          utterance: query,
          selectedLabel: query,
          session: {
            bookingDraft: null,
            pendingInteraction: state.pendingInteraction ?? null,
          },
          consultationDeclined: true,
          ...(options?.partitionCandidates != null
            ? { partitionCandidates: options.partitionCandidates }
            : {}),
          ...(options?.selectCandidates != null
            ? { selectCandidates: options.selectCandidates }
            : {}),
        })
      : await openRootFaqCatalog({
          services,
          bookingDraft: null,
          utterance: "catalog",
          ...(options?.partitionCandidates != null
            ? { partitionCandidates: options.partitionCandidates }
            : {}),
        });
    if (session?.pendingInteraction?.kind === "service_confirm") {
      // Unique match — keep FAQ informational highlight; do not start booking.
      const service = session.pendingInteraction.service;
      const highlighted = reduceBookingSession(
        {
          bookingDraft: null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        {
          type: "service_candidates_opened",
          utterance: query.length > 0 ? query : "catalog",
          owner: "faq",
          consultationDeclined: true,
          choices: [faqHighlightChoice(service.id, service.name)],
        },
      );
      serviceOfferUpdate = {
        ...servicesUpdate,
        pendingInteraction: highlighted.pendingInteraction,
      };
      const modelIntro = faqCatalogIntroFromModel(next.replyText);
      next = {
        ...next,
        replyText: renderFaqCatalogReply(
          highlighted.pendingInteraction?.kind === "service_candidate"
            ? highlighted.pendingInteraction.choices
            : [],
          services,
          modelIntro,
        ),
        replyButtons: highlighted.pendingInteraction != null
          ? replyButtonsForInteraction(highlighted.pendingInteraction)
          : [],
        replySource: "runtime",
      };
      trackEvent("reply_menu_filled", {
        menu: "service_candidate",
        reason: "faq_open_catalog_highlight",
      });
    } else if (session?.pendingInteraction != null) {
      serviceOfferUpdate = {
        ...servicesUpdate,
        pendingInteraction: session.pendingInteraction,
      };
      if (session.pendingInteraction.kind === "service_candidate") {
        const modelIntro = faqCatalogIntroFromModel(next.replyText);
        next = {
          ...next,
          replyText: renderFaqCatalogReply(
            session.pendingInteraction.choices,
            services,
            modelIntro,
          ),
          replyButtons: replyButtonsForInteraction(session.pendingInteraction),
          replySource: "runtime",
        };
        trackEvent("reply_menu_filled", {
          menu: "service_candidate",
          reason: "faq_open_catalog",
        });
      }
    } else if (Object.keys(servicesUpdate).length > 0) {
      serviceOfferUpdate = servicesUpdate;
    }
  } else if (openFaqCatalog) {
    const catalog = state.pendingInteraction as PendingInteraction & {
      kind: "service_candidate";
      owner: "faq";
    };
    if (faqCatalogAction === "offer_consultation") {
      // Consultation book goes through booking — FAQ does not open service_confirm.
      serviceOfferUpdate = {
        next: BOOKING_AGENT_ID,
        pendingInteraction: null,
        understoodTurn: {
          serviceIntent: { kind: "consultation" },
        },
      };
      next = {
        ...next,
        replyButtons: [],
        replySource: "runtime",
      };
      trackEvent("reply_menu_filled", {
        menu: "service_confirm",
        reason: "faq_catalog_consultation_handoff",
      });
    } else if (faqCatalogAction === "close_catalog") {
      serviceOfferUpdate = { pendingInteraction: null };
      next = { ...next, replyButtons: [] };
      trackEvent("reply_menu_filled", {
        menu: "service_candidate",
        reason: "faq_catalog_close",
      });
    } else {
      const preserved = faqCatalogAction === "keep_catalog"
        ? faqCatalogPreserveModelAnswer(next.replyText)
        : null;
      if (preserved != null) {
        next = {
          ...next,
          replyText: preserved,
          replyButtons: replyButtonsForInteraction(catalog),
        };
      } else {
        const modelIntro = faqCatalogAction === "keep_catalog"
          ? faqCatalogIntroFromModel(next.replyText)
          : "";
        next = {
          ...next,
          replyText: renderFaqCatalogReply(
            catalog.choices,
            state.servicesContext?.list ?? [],
            modelIntro,
          ),
          replyButtons: replyButtonsForInteraction(catalog),
        };
      }
      trackEvent("reply_menu_filled", {
        menu: "service_candidate",
        reason: "pending_interaction",
      });
    }
  } else if (openCatalogDetour) {
    next = {
      ...next,
      replyText: String(
        renderBookingInteractionMessage(state.pendingInteraction!).content,
      ),
      replyButtons: replyButtonsForInteraction(state.pendingInteraction!),
    };
    trackEvent("reply_menu_filled", {
      menu: state.pendingInteraction!.kind,
      reason: "pending_interaction",
    });
  } else {
    next = { ...next, replyButtons: [] };
    const returnLabel = state.pendingInteraction?.choices.find(
      (choice) => choice.id === "return_to_booking",
    )?.label;
    if (returnLabel != null && returnLabel.length > 0) {
      next = { ...next, replyButtons: [returnLabel] };
    }
  }

  return { reply: next, serviceOfferUpdate };
};

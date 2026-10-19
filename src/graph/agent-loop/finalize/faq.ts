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
  consultationService,
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking-session.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { ensureServicesContext } from "../protocol/index.js";
import {
  emptyFinalizeReply,
  faqCatalogChipReply,
  withServiceConfirmQuestion,
  type FinalizeReply,
} from "./shared.js";

export type FinalizeFaqOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** No-AI FAQ: prepare opened catalog or service_confirm without an LLM turn. */
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
    return {
      ...emptyFinalizeReply("ok"),
      replyText: chips.replyText,
      replyButtons: chips.replyButtons,
      replySource: "runtime",
      patch: {
        supervisorIntent: null,
        pendingInteraction: interaction,
      },
    };
  }
  if (interaction.kind === "service_confirm") {
    const baseText = String(renderBookingInteractionMessage(interaction).content);
    const replyButtons = replyButtonsForInteraction(interaction);
    return {
      ...emptyFinalizeReply("ok"),
      replyText: baseText,
      replyButtons,
      replySource: "runtime",
      yieldToSupervisor: true,
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

/** FAQ AI-path catalog: open_catalog / keep / close / offer-consultation / detour. */
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
            bookingDraft: state.bookingDraft ?? null,
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
          bookingDraft: state.bookingDraft ?? null,
          utterance: "catalog",
          ...(options?.partitionCandidates != null
            ? { partitionCandidates: options.partitionCandidates }
            : {}),
        });
    if (session?.pendingInteraction != null) {
      serviceOfferUpdate = {
        ...servicesUpdate,
        bookingDraft: session.bookingDraft,
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
      } else if (session.pendingInteraction.kind === "service_confirm") {
        next = {
          ...next,
          replyText: withServiceConfirmQuestion(
            next.replyText,
            session.pendingInteraction,
          ),
          replyButtons: replyButtonsForInteraction(session.pendingInteraction),
          replySource: "runtime",
          yieldToSupervisor: true,
        };
        trackEvent("reply_menu_filled", {
          menu: "service_confirm",
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
      if (catalog.consultationDeclined === true) {
        const singletonIds = catalog.choices.length === 1
          ? catalog.choices[0]?.serviceIds
          : undefined;
        const singletonService =
          singletonIds != null && singletonIds.length === 1
            ? (state.servicesContext?.list ?? []).find(
                (row) => row.id === singletonIds[0],
              )
            : undefined;
        if (singletonService != null) {
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft ?? null,
              pendingInteraction: catalog,
            },
            {
              type: "service_offered",
              service: {
                id: singletonService.id,
                name: singletonService.name,
                ...(singletonService.duration != null
                  ? { durationMinutes: singletonService.duration }
                  : {}),
                source: "catalog",
              },
            },
          );
          serviceOfferUpdate = {
            bookingDraft: session.bookingDraft,
            pendingInteraction: session.pendingInteraction,
          };
          if (session.pendingInteraction?.kind === "service_confirm") {
            next = {
              ...next,
              replyText: withServiceConfirmQuestion(
                next.replyText,
                session.pendingInteraction,
              ),
              replyButtons: replyButtonsForInteraction(
                session.pendingInteraction,
              ),
              yieldToSupervisor: true,
            };
            trackEvent("reply_menu_filled", {
              menu: "service_confirm",
              reason: "faq_catalog_declined_singleton",
            });
          }
        } else {
          const modelIntro = faqCatalogIntroFromModel(next.replyText);
          next = {
            ...next,
            replyText: renderFaqCatalogReply(
              catalog.choices,
              state.servicesContext?.list ?? [],
              modelIntro,
            ),
            replyButtons: replyButtonsForInteraction(catalog),
          };
          serviceOfferUpdate = { pendingInteraction: catalog };
          trackEvent("reply_menu_filled", {
            menu: "service_candidate",
            reason: "faq_offer_blocked_declined",
          });
        }
      } else {
        const session = reduceBookingSession(
          {
            bookingDraft: state.bookingDraft ?? null,
            pendingInteraction: catalog,
          },
          {
            type: "service_offered",
            service: consultationService("catalog"),
          },
        );
        serviceOfferUpdate = {
          bookingDraft: session.bookingDraft,
          pendingInteraction: session.pendingInteraction,
        };
        if (session.pendingInteraction?.kind === "service_confirm") {
          next = {
            ...next,
            replyText: withServiceConfirmQuestion(
              next.replyText,
              session.pendingInteraction,
            ),
            replyButtons: replyButtonsForInteraction(session.pendingInteraction),
            yieldToSupervisor: true,
          };
          trackEvent("reply_menu_filled", {
            menu: "service_confirm",
            reason: "faq_catalog_action",
          });
        }
      }
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
        // Price / product FAQ over open chips: keep model prose, attach chips.
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

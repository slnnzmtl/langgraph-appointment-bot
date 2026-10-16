import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../../types.js";
import { trackEvent } from "../../../analytics/track.js";
import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import {
  extractMessageTextContent,
  isFaqServicesGuideLabel,
  labelIdFor,
  type FaqCatalogAction,
} from "../../../shared/message-content.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import type { BookingService } from "../../booking-draft.js";
import {
  isFaqCatalogBrowseShortcut,
  openCatalogFromFreeText,
  openRootFaqCatalog,
} from "../../booking-entry-policy.js";
import {
  consultationService,
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking-session.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../../booking-interaction-render.js";
import {
  faqCatalogIntroFromModel,
  renderFaqCatalogReply,
} from "../../faq-catalog.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import { tagRuntimeAgentMessage } from "../../sub-agent-messages.js";
import { lastPatientText, toolRanThisTurn } from "../protocol.js";
import type { BookingAiReplyBag } from "./booking.js";
import type { ClearedTape } from "./shared.js";

/**
 * When the graph opens service_confirm it owns the only trailing question.
 * Drop any model-authored trailing question sentence so the patient never sees two.
 */
export const stripTrailingQuestion = (text: string): string => {
  const parts = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "";
  }
  const last = parts[parts.length - 1]!;
  if (!last.endsWith("?")) {
    return parts.join("\n\n").trim();
  }
  const boundary = Math.max(
    last.lastIndexOf("."),
    last.lastIndexOf("!"),
    last.lastIndexOf("\n"),
  );
  const withoutQuestion = boundary >= 0
    ? last.slice(0, boundary + (last[boundary] === "\n" ? 0 : 1)).trim()
    : "";
  if (withoutQuestion.length === 0) {
    parts.pop();
  } else {
    parts[parts.length - 1] = withoutQuestion;
  }
  trackEvent("faq_offer_question_dropped", { reason: "model_trailing_question" });
  return parts.join("\n\n").trim();
};

/** Patient text = optional model explanation + deterministic service_confirm question. */
export const withServiceConfirmQuestion = (
  modelText: string,
  interaction: PendingInteraction & { kind: "service_confirm" },
): string => {
  const question = String(renderBookingInteractionMessage(interaction).content);
  const explanation = stripTrailingQuestion(modelText);
  if (explanation.length === 0) {
    return question;
  }
  return `${explanation}\n\n${question}`;
};

/**
 * Resolve which CRM service a specialist is offering this turn without reading
 * offer-question wording. Keyboard chips open consultation; named CRM rows
 * come from FAQ `open_catalog` (model query), not patient-line title matching.
 */
export const offeredServiceForTurn = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
): BookingService | null => {
  if (state.bookingDraft?.serviceAcceptance?.status === "accepted") {
    return null;
  }
  // Mid-catalog drill-down is owned by FAQ service_candidate, not a book offer.
  if (
    state.pendingInteraction?.kind === "service_candidate"
    && state.pendingInteraction.owner === "faq"
  ) {
    return null;
  }
  const lastHuman = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  ).at(-1);
  const lastHumanText = lastHuman != null
    ? extractMessageTextContent(lastHuman.content).trim()
    : "";
  // «Обрати іншу процедуру» / bare «Ні» on an open offer — do not re-offer.
  if (isFaqCatalogBrowseShortcut(lastHumanText, state.pendingInteraction)) {
    return null;
  }
  if (state.bookingDraft?.serviceAcceptance?.status === "pending") {
    return state.bookingDraft.serviceAcceptance.service;
  }
  if (agentId !== FAQ_AGENT_ID && agentId !== BOOKING_AGENT_ID) {
    return null;
  }
  // «Послуги» / «Записатись» → consultation even when list_services ran this turn.
  if (
    labelIdFor(lastHumanText) === "mainBook"
    || isFaqServicesGuideLabel(lastHumanText)
  ) {
    return consultationService("catalog");
  }
  if (toolRanThisTurn(agentMessages, "list_services")) {
    return null;
  }
  return null;
};

/** Prepare opened FAQ catalog or a catalog offer without an LLM turn. */
export const finalizeNonAiFaq = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  cleared: ClearedTape,
  confirmationCleanup: ClinicStateUpdate,
): ClinicStateUpdate | null => {
  if (agent.id !== FAQ_AGENT_ID || state.pendingInteraction == null) {
    return null;
  }
  const interaction = state.pendingInteraction;
  if (
    interaction.kind === "service_candidate"
    && interaction.owner === "faq"
  ) {
    const replyText = renderFaqCatalogReply(
      interaction.choices,
      state.servicesContext?.list ?? [],
    );
    const replyButtons = replyButtonsForInteraction(interaction);
    return {
      ...cleared,
      ...confirmationCleanup,
      supervisorIntent: null,
      pendingInteraction: interaction,
      messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
      lastHandoff: {
        agentId: agent.id,
        agentName: agent.name,
        status: "ok",
        replyText,
        replyButtons,
      },
    };
  }
  if (interaction.kind === "service_confirm") {
    const replyText = String(renderBookingInteractionMessage(interaction).content);
    const replyButtons = replyButtonsForInteraction(interaction);
    return {
      ...cleared,
      ...confirmationCleanup,
      supervisorIntent: null,
      pendingInteraction: interaction,
      messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
      lastHandoff: {
        agentId: agent.id,
        agentName: agent.name,
        status: "ok",
        replyText,
        replyButtons,
        yieldToSupervisor: true,
      },
    };
  }
  return null;
};

/**
 * FAQ catalog strip / catalog-action reply shaping used in the AI branch.
 * Mutates bag in place.
 */
export const applyFaqAiCatalogShaping = async (
  state: ClinicState,
  faqCatalogAction: FaqCatalogAction | null,
  faqCatalogQuery: string | null,
  bag: BookingAiReplyBag,
  options?: {
    partitionCandidates?: PartitionServiceCandidates;
    selectCandidates?: SelectServiceCandidates;
    loadServices?: () => Promise<ServicesContext | null>;
  },
): Promise<void> => {
  if (faqCatalogAction === "open_catalog") {
    // Model-authored open — matcher runs only on the tag query (not patient prose).
    let services = state.servicesContext?.list ?? [];
    let servicesUpdate: ClinicStateUpdate = {};
    if (services.length === 0 && options?.loadServices != null) {
      const loaded = await options.loadServices().catch(() => null);
      if (loaded != null && loaded.list.length > 0) {
        servicesUpdate = { servicesContext: loaded };
        services = loaded.list;
      }
    }
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
      bag.serviceOfferUpdate = {
        ...servicesUpdate,
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      };
      if (session.pendingInteraction.kind === "service_candidate") {
        const modelIntro = faqCatalogIntroFromModel(bag.replyText);
        bag.replyText = renderFaqCatalogReply(
          session.pendingInteraction.choices,
          services,
          modelIntro,
        );
        bag.replyButtons = replyButtonsForInteraction(session.pendingInteraction);
        bag.replySource = "runtime";
        trackEvent("reply_menu_filled", {
          menu: "service_candidate",
          reason: "faq_open_catalog",
        });
      } else if (session.pendingInteraction.kind === "service_confirm") {
        bag.replyText = withServiceConfirmQuestion(
          bag.replyText,
          session.pendingInteraction,
        );
        bag.replyButtons = replyButtonsForInteraction(session.pendingInteraction);
        bag.replySource = "runtime";
        bag.yieldFlag = true;
        trackEvent("reply_menu_filled", {
          menu: "service_confirm",
          reason: "faq_open_catalog",
        });
      }
    } else if (Object.keys(servicesUpdate).length > 0) {
      bag.serviceOfferUpdate = servicesUpdate;
    }
    return;
  }

  const pending = state.pendingInteraction;
  if (pending?.kind === "service_candidate" && pending.owner === "faq") {
    const catalog = pending;
    switch (faqCatalogAction) {
      case "offer_consultation": {
        // Patient already declined consultation («Обрати іншу процедуру» /
        // bare «Ні») — keep browsing. Singleton catalog level → offer that
        // procedure instead of reopening the consultation yes/no.
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
            bag.serviceOfferUpdate = {
              bookingDraft: session.bookingDraft,
              pendingInteraction: session.pendingInteraction,
            };
            if (session.pendingInteraction?.kind === "service_confirm") {
              bag.replyText = withServiceConfirmQuestion(
                bag.replyText,
                session.pendingInteraction,
              );
              bag.replyButtons = replyButtonsForInteraction(
                session.pendingInteraction,
              );
              bag.yieldFlag = true;
              trackEvent("reply_menu_filled", {
                menu: "service_confirm",
                reason: "faq_catalog_declined_singleton",
              });
            }
          } else {
            const modelIntro = faqCatalogIntroFromModel(bag.replyText);
            bag.replyText = renderFaqCatalogReply(
              catalog.choices,
              state.servicesContext?.list ?? [],
              modelIntro,
            );
            bag.replyButtons = replyButtonsForInteraction(catalog);
            // Keep the open catalog explicitly so the decline flag survives.
            bag.serviceOfferUpdate = { pendingInteraction: catalog };
            trackEvent("reply_menu_filled", {
              menu: "service_candidate",
              reason: "faq_offer_blocked_declined",
            });
          }
          return;
        }
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
        bag.serviceOfferUpdate = {
          bookingDraft: session.bookingDraft,
          pendingInteraction: session.pendingInteraction,
        };
        if (session.pendingInteraction?.kind === "service_confirm") {
          bag.replyText = withServiceConfirmQuestion(bag.replyText, session.pendingInteraction);
          bag.replyButtons = replyButtonsForInteraction(session.pendingInteraction);
          bag.yieldFlag = true;
          trackEvent("reply_menu_filled", {
            menu: "service_confirm",
            reason: "faq_catalog_action",
          });
        }
        return;
      }
      case "close_catalog": {
        bag.serviceOfferUpdate = { pendingInteraction: null };
        // Keep model prose; drop catalog chips.
        bag.replyButtons = [];
        trackEvent("reply_menu_filled", {
          menu: "service_candidate",
          reason: "faq_catalog_close",
        });
        return;
      }
      default: {
        // keep_catalog may keep a short clarification; missing/invalid drop
        // model prose so stale choose_other copy cannot diverge from chips.
        const modelIntro = faqCatalogAction === "keep_catalog"
          ? faqCatalogIntroFromModel(bag.replyText)
          : "";
        bag.replyText = renderFaqCatalogReply(
          catalog.choices,
          state.servicesContext?.list ?? [],
          modelIntro,
        );
        bag.replyButtons = replyButtonsForInteraction(catalog);
        trackEvent("reply_menu_filled", {
          menu: "service_candidate",
          reason: "pending_interaction",
        });
        return;
      }
    }
  }

  if (pending?.kind === "catalog_detour") {
    bag.replyText = String(renderBookingInteractionMessage(pending).content);
    bag.replyButtons = replyButtonsForInteraction(pending);
    trackEvent("reply_menu_filled", {
      menu: pending.kind,
      reason: "pending_interaction",
    });
    return;
  }

  // Accidental trailers / bullets never become FAQ chips — only reducer-
  // opened catalog interactions own replyButtons.
  bag.replyButtons = [];
  const returnLabel = pending?.choices.find(
    (choice) => choice.id === "return_to_booking",
  )?.label;
  if (returnLabel != null && returnLabel.length > 0) {
    bag.replyButtons = [returnLabel];
  }
};

/**
 * Open service_confirm from structured service identity (not offer-question prose),
 * or refresh chips when service_confirm is already pending.
 * Mutates bag in place.
 */
export const applyServiceConfirmOfferShaping = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  bag: BookingAiReplyBag,
): void => {
  if (
    !bag.alreadyBooked
    && !bag.slotOffer
    && bag.availabilityInteraction == null
    && state.pendingInteraction?.kind !== "service_confirm"
    && (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID)
  ) {
    const offeredService = offeredServiceForTurn(state, agent.id, agentMessages);
    if (offeredService != null) {
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "service_offered", service: offeredService },
      );
      bag.serviceOfferUpdate = {
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      };
      if (session.pendingInteraction?.kind === "service_confirm") {
        // FAQ «Послуги» keeps the model catalog summary and always closes
        // with a consultation offer so Так / Обрати іншу процедуру make sense.
        const servicesGuide = isFaqServicesGuideLabel(lastPatientText(state));
        if (
          agent.id === FAQ_AGENT_ID
          && servicesGuide
          && offeredService.id === CONSULTATION_SERVICE_ID
        ) {
          bag.replyText = withServiceConfirmQuestion(bag.replyText, session.pendingInteraction);
        } else if (bag.replyText.length === 0) {
          bag.replyText = String(
            renderBookingInteractionMessage(session.pendingInteraction).content,
          );
        }
        if (bag.detailsStep == null) {
          bag.replyButtons = replyButtonsForInteraction(session.pendingInteraction);
        }
        if (agent.id === FAQ_AGENT_ID) {
          bag.yieldFlag = true;
        }
        trackEvent("reply_menu_filled", { menu: "service_confirm", reason: "pending_interaction" });
      }
    }
    return;
  }
  if (
    state.pendingInteraction?.kind === "service_confirm"
    && bag.detailsStep == null
    && !bag.alreadyBooked
    && !bag.slotOffer
    && bag.replyButtons.length === 0
  ) {
    // Offer keyboard still open (price/comparison follow-up, unmatched
    // text). Catalog resume happens in prepare: it opens service_candidate
    // before the LLM, and keep_catalog then attaches those chips above.
    if (bag.replyText.length === 0) {
      bag.replyText = String(renderBookingInteractionMessage(state.pendingInteraction).content);
    }
    bag.replyButtons = replyButtonsForInteraction(state.pendingInteraction);
    if (agent.id === FAQ_AGENT_ID) {
      bag.yieldFlag = true;
    }
    trackEvent("reply_menu_filled", { menu: "service_confirm", reason: "pending_interaction" });
  }
};

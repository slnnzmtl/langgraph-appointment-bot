import { isFaqServicesGuideLabel } from "../../../shared/message-content.js";
import {
  isFaqCatalogBrowseShortcut,
  openCatalogFromFreeText,
  openRootFaqCatalog,
} from "../../booking/booking-entry-policy.js";
import {
  faqHighlightChoice,
  faqHighlightedService,
} from "../../faq-highlight.js";
import {
  interpretInteractionReply,
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking/booking-session.js";
import { resolveFaqCatalogChoices } from "../../catalog/faq-catalog.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "../../catalog/service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import {
  ensureServicesContext,
  lastPatientText,
} from "../protocol/index.js";

export type PrepareFaqOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** True when prepare opened or narrowed FAQ catalog chips. */
const faqUiProduced = (pendingInteraction: PendingInteraction | null | undefined): boolean =>
  pendingInteraction?.kind === "service_candidate"
  && pendingInteraction.owner === "faq";

const faqCatalogAlreadyOpen = (interaction: PendingInteraction | null | undefined): boolean =>
  interaction?.kind === "service_candidate" && interaction.owner === "faq";

const openFaqHighlight = (
  interaction: PendingInteraction & { kind: "service_candidate" },
  serviceId: string,
  serviceName: string | undefined,
  update: ClinicStateUpdate,
): ClinicStateUpdate => {
  const session = reduceBookingSession(
    {
      bookingDraft: null,
      pendingInteraction: interaction,
    },
    {
      type: "service_candidates_opened",
      utterance: interaction.utterance,
      owner: "faq",
      ...(interaction.consultationDeclined === true
        ? { consultationDeclined: true }
        : {}),
      choices: [faqHighlightChoice(serviceId, serviceName)],
    },
  );
  update.pendingInteraction = session.pendingInteraction;
  if (faqUiProduced(session.pendingInteraction)) {
    update.faqSkipLlm = true;
  }
  return update;
};

/**
 * FAQ prepare: catalog chips and browse only. Never assigns bookingDraft.
 * Unique CRM id stays FAQ-owned (informational highlight) until an explicit book.
 */
export const prepareFaqTurn = async (
  state: ClinicState,
  options?: PrepareFaqOptions,
): Promise<ClinicStateUpdate> => {
  const update: ClinicStateUpdate = { faqSkipLlm: false };
  const interaction = state.pendingInteraction;
  const patientText = lastPatientText(state).trim();
  let handledCatalogChoice = false;

  if (interaction?.kind === "service_candidate" && interaction.owner === "faq") {
    const match = interpretInteractionReply(interaction, patientText);
    if (match.kind === "choice") {
      handledCatalogChoice = true;
      const choice = interaction.choices.find((entry) => entry.id === match.choiceId);
      const remainingIds = choice?.serviceIds != null && choice.serviceIds.length > 0
        ? choice.serviceIds
        : [match.choiceId];
      const services = state.servicesContext?.list ?? [];
      if (remainingIds.length === 1) {
        const alreadyHighlighted = faqHighlightedService(interaction);
        // Re-tapping the unique highlight chip must not re-open a one-item picker.
        if (
          alreadyHighlighted != null
          && alreadyHighlighted.serviceId === remainingIds[0]
        ) {
          update.pendingInteraction = interaction;
          update.faqSkipLlm = true;
          return update;
        }
        const row = services.find((service) => service.id === remainingIds[0]);
        if (row == null) {
          update.pendingInteraction = null;
          return update;
        }
        return openFaqHighlight(
          interaction,
          remainingIds[0]!,
          row.name,
          update,
        );
      }
      const selectedLabel = choice != null
        ? (choice.displayLabel ?? choice.label).trim()
        : patientText;
      const choices = await resolveFaqCatalogChoices({
        services,
        remainingIds,
        utterance: patientText || interaction.utterance,
        ...(selectedLabel.length > 0 ? { selectedLabel } : {}),
        ...(options?.partitionCandidates != null
          ? { partitionCandidates: options.partitionCandidates }
          : {}),
      });
      const session = reduceBookingSession(
        {
          bookingDraft: null,
          pendingInteraction: interaction,
        },
        {
          type: "service_candidates_opened",
          utterance: interaction.utterance,
          owner: "faq",
          ...(interaction.consultationDeclined === true
            ? { consultationDeclined: true }
            : {}),
          choices,
        },
      );
      update.pendingInteraction = session.pendingInteraction;
      if (faqUiProduced(session.pendingInteraction)) {
        update.faqSkipLlm = true;
      }
    } else if (patientText.length > 0) {
      const rematch = await ensureServicesContext(
        state.servicesContext,
        options?.loadServices,
      );
      if (rematch.loaded != null) {
        update.servicesContext = rematch.loaded;
      }
      if (rematch.list.length > 0) {
        const rematchSession = await openCatalogFromFreeText({
          text: patientText,
          services: rematch.list,
          session: {
            bookingDraft: null,
            pendingInteraction: interaction,
          },
          utterance: patientText,
          ...(interaction.consultationDeclined === true
            ? { consultationDeclined: true }
            : {}),
          ...(options?.partitionCandidates != null
            ? { partitionCandidates: options.partitionCandidates }
            : {}),
          ...(options?.selectCandidates != null
            ? { selectCandidates: options.selectCandidates }
            : {}),
        });
        // Singleton free-text used to open service_confirm (booking). Keep FAQ highlight.
        if (rematchSession?.pendingInteraction?.kind === "service_confirm") {
          const service = rematchSession.pendingInteraction.service;
          return openFaqHighlight(
            interaction,
            service.id,
            service.name,
            update,
          );
        }
        if (rematchSession?.pendingInteraction != null) {
          handledCatalogChoice = true;
          update.pendingInteraction = rematchSession.pendingInteraction;
          if (faqUiProduced(rematchSession.pendingInteraction)) {
            update.faqSkipLlm = true;
          }
        }
      }
    }
  } else if (interaction?.kind === "catalog_detour") {
    const match = interpretInteractionReply(interaction, patientText);
    if (match.kind === "choice" && match.choiceId === "return_to_booking") {
      const session = reduceBookingSession(
        {
          bookingDraft: null,
          pendingInteraction: interaction,
        },
        { type: "interaction_choice", choiceId: "return_to_booking" },
      );
      update.pendingInteraction = session.pendingInteraction;
    }
  }

  // «Послуги» tap: root FAQ chips without waiting on the FAQ LLM.
  // REPLACE cancel catalog stays in the booking kernel (list_services).
  const servicesGuideNeedsCatalog =
    !handledCatalogChoice
    && isFaqServicesGuideLabel(patientText)
    && !faqCatalogAlreadyOpen(interaction);
  if (servicesGuideNeedsCatalog) {
    const catalog = await ensureServicesContext(
      state.servicesContext,
      options?.loadServices,
    );
    if (catalog.loaded != null) {
      update.servicesContext = catalog.loaded;
    }
    if (catalog.list.length > 0) {
      const session = await openRootFaqCatalog({
        services: catalog.list,
        bookingDraft: null,
        ...(options?.partitionCandidates != null
          ? { partitionCandidates: options.partitionCandidates }
          : {}),
      });
      if (session != null) {
        update.pendingInteraction = session.pendingInteraction;
        handledCatalogChoice = true;
        if (faqUiProduced(session.pendingInteraction)) {
          update.faqSkipLlm = true;
        }
      }
    }
  }

  // Browse open: «Обрати іншу процедуру» / bare «Ні» — root partition.
  const browseShortcut = isFaqCatalogBrowseShortcut(
    patientText,
    state.pendingInteraction,
  );
  let browseList = state.servicesContext?.list ?? [];
  if (!handledCatalogChoice && browseShortcut) {
    const browse = await ensureServicesContext(
      state.servicesContext,
      options?.loadServices,
    );
    if (browse.loaded != null) {
      update.servicesContext = browse.loaded;
    }
    browseList = browse.list;
  }
  if (
    !handledCatalogChoice
    && browseShortcut
    && browseList.length > 0
  ) {
    const services = browseList;
    const choices = await resolveFaqCatalogChoices({
      services,
      utterance: patientText,
      query: FAQ_ROOT_PARTITION_QUERY,
      ...(options?.partitionCandidates != null
        ? { partitionCandidates: options.partitionCandidates }
        : {}),
    });
    if (choices.length > 0) {
      const session = reduceBookingSession(
        {
          bookingDraft: null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        {
          type: "service_candidates_opened",
          utterance: patientText || "catalog",
          owner: "faq",
          consultationDeclined: true,
          choices,
        },
      );
      update.pendingInteraction = session.pendingInteraction;
      if (faqUiProduced(session.pendingInteraction)) {
        update.faqSkipLlm = true;
      }
    }
  }
  return update;
};

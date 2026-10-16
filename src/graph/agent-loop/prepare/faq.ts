import type { ServicesContext } from "../../../tools/service-tools.js";
import {
  isFaqCatalogBrowseShortcut,
  faqNamedProcedureEntryForTurn,
  openCatalogFromFreeText,
} from "../../booking-entry-policy.js";
import { interpretInteractionReply, reduceBookingSession } from "../../booking-session.js";
import { resolveFaqCatalogChoices } from "../../faq-catalog.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { lastPatientText } from "../protocol.js";

/** FAQ prepare: catalog choice / rematch / browse shortcut / named_procedure. */
export const applyFaqPrepareTurn = async (
  state: ClinicState,
  update: ClinicStateUpdate,
  options?: {
    partitionCandidates?: PartitionServiceCandidates;
    selectCandidates?: SelectServiceCandidates;
    loadServices?: () => Promise<ServicesContext | null>;
  },
): Promise<void> => {
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
        const row = services.find((service) => service.id === remainingIds[0]);
        if (row != null) {
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft ?? null,
              pendingInteraction: interaction,
            },
            {
              type: "service_offered",
              service: {
                id: row.id,
                name: row.name,
                ...(row.duration != null ? { durationMinutes: row.duration } : {}),
                source: "catalog",
              },
            },
          );
          update.bookingDraft = session.bookingDraft;
          update.pendingInteraction = session.pendingInteraction;
        }
      } else {
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
            bookingDraft: state.bookingDraft ?? null,
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
      }
    } else if (patientText.length > 0) {
      // Unmatched prose: rematch the full catalog (same helper as idle
      // named_procedure / model open_catalog). one/many replaces the
      // picker; none leaves chips for the FAQ LLM (price, compare, …).
      let rematchServices = state.servicesContext?.list ?? [];
      if (rematchServices.length === 0 && options?.loadServices != null) {
        const loaded = await options.loadServices().catch(() => null);
        if (loaded != null && loaded.list.length > 0) {
          update.servicesContext = loaded;
          rematchServices = loaded.list;
        }
      }
      if (rematchServices.length > 0) {
        const rematchSession = await openCatalogFromFreeText({
          text: patientText,
          services: rematchServices,
          session: {
            bookingDraft: state.bookingDraft ?? null,
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
        if (rematchSession?.pendingInteraction != null) {
          handledCatalogChoice = true;
          update.bookingDraft = rematchSession.bookingDraft;
          update.pendingInteraction = rematchSession.pendingInteraction;
        }
      }
    }
  } else if (interaction?.kind === "catalog_detour") {
    const match = interpretInteractionReply(interaction, patientText);
    if (match.kind === "choice" && match.choiceId === "return_to_booking") {
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: interaction,
        },
        { type: "interaction_choice", choiceId: "return_to_booking" },
      );
      update.pendingInteraction = session.pendingInteraction;
    }
  }
  // Browse open: «Обрати іншу процедуру» / bare «Ні» (not «Послуги») — root partition.
  let browseServices = state.servicesContext?.list ?? [];
  const browseShortcut = isFaqCatalogBrowseShortcut(
    patientText,
    state.pendingInteraction,
  );
  if (
    !handledCatalogChoice
    && browseShortcut
    && browseServices.length === 0
    && options?.loadServices != null
  ) {
    const loaded = await options.loadServices().catch(() => null);
    if (loaded != null && loaded.list.length > 0) {
      update.servicesContext = loaded;
      browseServices = loaded.list;
    }
  }
  if (
    !handledCatalogChoice
    && browseShortcut
    && browseServices.length > 0
  ) {
    const services = browseServices;
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
          bookingDraft: state.bookingDraft ?? null,
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
    }
  }
  // Named-procedure book (supervisor intent): open catalog without the FAQ LLM.
  const namedProcedureIdle =
    !handledCatalogChoice
    && !browseShortcut
    && state.supervisorIntent === "named_procedure"
    && !(
      interaction?.kind === "service_candidate" && interaction.owner === "faq"
    );
  if (namedProcedureIdle) {
    let namedServices = state.servicesContext?.list ?? [];
    if (namedServices.length === 0 && options?.loadServices != null) {
      const loaded = await options.loadServices().catch(() => null);
      if (loaded != null && loaded.list.length > 0) {
        update.servicesContext = loaded;
        namedServices = loaded.list;
      }
    }
    const namedSession = await faqNamedProcedureEntryForTurn({
      supervisorIntent: state.supervisorIntent,
      patientText,
      services: namedServices,
      session: {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      alreadyHandled: false,
      ...(options?.partitionCandidates != null
        ? { partitionCandidates: options.partitionCandidates }
        : {}),
      ...(options?.selectCandidates != null
        ? { selectCandidates: options.selectCandidates }
        : {}),
    });
    if (namedSession?.pendingInteraction != null) {
      update.bookingDraft = namedSession.bookingDraft;
      update.pendingInteraction = namedSession.pendingInteraction;
    }
  }
};

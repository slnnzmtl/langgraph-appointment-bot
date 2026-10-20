import { isFaqServicesGuideLabel } from "../../../shared/message-content.js";
import {
  isFaqCatalogBrowseShortcut,
  faqNamedProcedureEntryForTurn,
  openCatalogFromFreeText,
  openRootFaqCatalog,
} from "../../booking-entry-policy.js";
import {
  interpretInteractionReply,
  reduceBookingSession,
} from "../../booking-session.js";
import { resolveFaqCatalogChoices } from "../../faq-catalog.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "../../service-resolution.js";
import type { PendingInteraction } from "../../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import type { ServicesContext } from "../../../tools/service-tools.js";
import {
  ensureServicesContext,
  lastPatientText,
  toolRanThisTurn,
} from "../protocol/index.js";

export type PrepareFaqOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

/** True when prepare opened or narrowed FAQ catalog chips / service_confirm. */
const faqUiProduced = (pendingInteraction: PendingInteraction | null | undefined): boolean =>
  pendingInteraction?.kind === "service_confirm"
  || (
    pendingInteraction?.kind === "service_candidate"
    && pendingInteraction.owner === "faq"
  );

/**
 * Post-REPLACE-cancel create draft with cancel_meeting still on the agent tape.
 * Shared by FAQ prepare (open catalog) and prepare wipe (keep tape for ack).
 */
export const isReplaceCancelCreateDraft = (state: ClinicState): boolean =>
  state.bookingDraft?.mode === "create"
  && state.bookingDraft.replacement == null
  && state.bookingDraft.serviceAcceptance?.status !== "accepted"
  && toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting");

const faqCatalogAlreadyOpen = (interaction: PendingInteraction | null | undefined): boolean =>
  interaction?.kind === "service_candidate" && interaction.owner === "faq";

/** FAQ prepare: catalog chips, rematch, browse shortcut, named-procedure entry. */
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
          if (faqUiProduced(session.pendingInteraction)) {
            update.faqSkipLlm = true;
          }
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
        if (faqUiProduced(session.pendingInteraction)) {
          update.faqSkipLlm = true;
        }
      }
    } else if (patientText.length > 0) {
      // Unmatched prose: rematch the full catalog (same helper as idle
      // named_procedure / model open_catalog). one/many replaces the
      // picker; none leaves chips for the FAQ LLM (price, compare, …).
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
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: interaction,
        },
        { type: "interaction_choice", choiceId: "return_to_booking" },
      );
      update.pendingInteraction = session.pendingInteraction;
    }
  }
  // REPLACE cancel continue: booking tools completed cancel without opening
  // the catalog — load services if needed and open root FAQ chips here.
  // After REPLACE cancel completes, draft is create with no accepted service —
  // open the root FAQ catalog so the patient can pick the new visit type.
  // «Послуги» tap: same root chips without waiting on the FAQ LLM.
  const servicesGuideNeedsCatalog =
    !handledCatalogChoice
    && isFaqServicesGuideLabel(patientText)
    && !faqCatalogAlreadyOpen(interaction);
  const replacementCancelNeedsCatalog =
    !handledCatalogChoice
    && !faqCatalogAlreadyOpen(interaction)
    && isReplaceCancelCreateDraft(state);
  if (replacementCancelNeedsCatalog || servicesGuideNeedsCatalog) {
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
        bookingDraft: state.bookingDraft ?? null,
        ...(options?.partitionCandidates != null
          ? { partitionCandidates: options.partitionCandidates }
          : {}),
      });
      if (session != null) {
        update.bookingDraft = session.bookingDraft;
        update.pendingInteraction = session.pendingInteraction;
        handledCatalogChoice = true;
        if (faqUiProduced(session.pendingInteraction)) {
          update.faqSkipLlm = true;
        }
      }
    }
  }

  // Browse open: «Обрати іншу процедуру» / bare «Ні» (not «Послуги») — root partition.
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
      if (faqUiProduced(session.pendingInteraction)) {
        update.faqSkipLlm = true;
      }
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
    const named = await ensureServicesContext(
      state.servicesContext,
      options?.loadServices,
    );
    if (named.loaded != null) {
      update.servicesContext = named.loaded;
    }
    const namedSession = await faqNamedProcedureEntryForTurn({
      supervisorIntent: state.supervisorIntent,
      patientText,
      services: named.list,
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
      if (faqUiProduced(namedSession.pendingInteraction)) {
        update.faqSkipLlm = true;
      }
    }
  }
  return update;
};

import { Overwrite } from "@langchain/langgraph";

import { trackEvent } from "../../analytics/track.js";
import { parseScheduleIntent } from "../../shared/booking-schedule.js";
import {
  bookingOfferLabels,
  inferConversationLocaleFromText,
} from "../../shared/conversation-locale.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { kyivToday } from "../../tools/availability-slots.js";
import type { ServicesContext } from "../../tools/service-tools.js";
import {
  isFaqCatalogBrowseShortcut,
  faqNamedProcedureEntryForTurn,
  openCatalogFromFreeText,
} from "../booking-entry-policy.js";
import { restorePendingInteraction } from "../booking-interaction-restore.js";
import { bookingTurnNeedsNoteOrchestrator } from "../booking-note-orchestrator.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../booking-draft.js";
import {
  consultationService,
  interpretInteractionReply,
  reduceBookingSession,
  repairInvalidScheduleInteraction,
} from "../booking-session.js";
import { resolveContactIdentity } from "../contact-command.js";
import type { ClassifyContactNameTurn } from "../contact-name-classifier.js";
import { resolveFaqCatalogChoices } from "../faq-catalog.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { stripToolNoiseFromMessages } from "../supervisor-history.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "../types.js";
import {
  advanceBookingNoteStep,
  rescheduleTargetFromBookingContext,
} from "./booking-command.js";
import { lastPatientText } from "./protocol.js";
import { bookingEntryTransitionForTurn } from "./replacement-flow.js";

export type CreateAgentPrepareOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  /** LLM catalog filter for free-text slang («ботокс») that lexical matching misses. */
  selectCandidates?: SelectServiceCandidates;
  /** Fetch the CRM catalog when «Обрати іншу процедуру» arrives before any list_services. */
  loadServices?: () => Promise<ServicesContext | null>;
  /** Classify first/last name replies while contact_field is open (booking). */
  classifyContactName?: ClassifyContactNameTurn;
};

export const createAgentPrepareNode = (
  agentId: string,
  options?: CreateAgentPrepareOptions,
) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
      stepCount: 0,
    };
    if (agentId === FAQ_AGENT_ID) {
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
    }
    if (agentId === BOOKING_AGENT_ID) {
      const scheduleRepair = repairInvalidScheduleInteraction(
        state.bookingDraft,
        state.pendingInteraction,
        state.bookingContext?.meetings ?? [],
      );
      if (scheduleRepair != null) {
        trackEvent("booking_invariant_violation", { reason: scheduleRepair.reason });
        update.bookingDraft = scheduleRepair.bookingDraft;
        update.pendingInteraction = scheduleRepair.pendingInteraction;
        if (scheduleRepair.clearAvailability) {
          update.availabilityContext = null;
          update.availabilityCursor = null;
        }
      }
      // Intentional null from scheduleRepair must not fall through ?? to the
      // corrupt checkpoint. Undefined on update means "leave state as-is".
      type Pending = typeof state.pendingInteraction;
      const draftForRestore = scheduleRepair != null
        ? scheduleRepair.bookingDraft
        : (update.bookingDraft !== undefined
          ? (update.bookingDraft as BookingDraft | null)
          : state.bookingDraft);
      const pendingForRestore: Pending = scheduleRepair != null
        ? scheduleRepair.pendingInteraction
        : (update.pendingInteraction !== undefined
          ? (update.pendingInteraction as Pending)
          : state.pendingInteraction);
      const restoredInteraction = restorePendingInteraction({
        bookingDraft: draftForRestore,
        pendingInteraction: pendingForRestore,
        availabilityContext: scheduleRepair?.clearAvailability
          ? null
          : state.availabilityContext,
        contactContext: state.contactContext,
        bookingContext: state.bookingContext,
        lastHandoff: state.lastHandoff,
        prefetchFresh: state.prefetchDirty !== true && state.prefetchFetchedAt != null,
      });
      if (
        restoredInteraction != null
        && pendingForRestore == null
      ) {
        update.pendingInteraction = restoredInteraction;
      }
      const contactIdentity = resolveContactIdentity(state.contactContext);
      const contactId = contactIdentity.kind === "owned" ? contactIdentity.contactId : null;
      // Fold all events from this turn into one local aggregate. In particular,
      // service acceptance and the date/time/note ladder must never each reduce
      // from the stale checkpoint and then overwrite one another.
      const effectivePending: Pending = update.pendingInteraction !== undefined
        ? (update.pendingInteraction as Pending)
        : state.pendingInteraction;
      const repairedBase: ClinicState = {
        ...state,
        bookingDraft: draftForRestore ?? null,
        pendingInteraction: effectivePending ?? null,
        ...(scheduleRepair?.clearAvailability
          ? { availabilityContext: null, availabilityCursor: null }
          : {}),
      };
      // Reschedule is seeded by the supervisor (pending_reschedule / chip / sticky).
      // Prepare only fills a missing target on an already-reschedule draft.
      const rescheduleTarget = repairedBase.bookingDraft?.mode === "reschedule"
        ? rescheduleTargetFromBookingContext(repairedBase)
        : null;
      const startedReschedule =
        repairedBase.bookingDraft?.mode === "reschedule"
        && repairedBase.bookingDraft.rescheduleTarget == null
        && rescheduleTarget != null
          ? reduceBookingDraft(repairedBase.bookingDraft, {
              type: "reschedule_started",
              meeting: rescheduleTarget,
            })
          : undefined;
      const rescheduleState = {
        ...(startedReschedule
          ? { ...repairedBase, bookingDraft: startedReschedule }
          : repairedBase),
        pendingInteraction: effectivePending ?? repairedBase.pendingInteraction ?? null,
      };
      // Orch ownership is inbound-only so a slot pick that opens visit_note
      // this turn still reaches the booking LLM. Skip utterance-driven draft
      // mutations when the orch already owns the turn.
      // After clearing an illegal DATE/TIME card (+ availability), do not hand
      // the turn to note orch solely because phase is still date/time — the
      // booking LLM must re-offer slots.
      const queueNoteOrch = scheduleRepair != null
        && scheduleRepair.pendingInteraction == null
        && scheduleRepair.clearAvailability
        ? false
        : bookingTurnNeedsNoteOrchestrator(rescheduleState);
      update.noteOrchQueued = queueNoteOrch;
      let bookingDraft: BookingDraft | null | undefined =
        rescheduleState.bookingDraft ?? undefined;
      let pendingInteraction = rescheduleState.pendingInteraction ?? null;
      if (!queueNoteOrch) {
        if (pendingInteraction?.kind === "service_confirm") {
          const patientText = lastPatientText(rescheduleState);
          const choice = interpretInteractionReply(pendingInteraction, patientText);
          if (choice.kind === "choice") {
            const session = reduceBookingSession(
              { bookingDraft: bookingDraft ?? null, pendingInteraction },
              { type: "interaction_choice", choiceId: choice.choiceId },
            );
            bookingDraft = session.bookingDraft;
            pendingInteraction = session.pendingInteraction;
            if (session.clearAvailability) {
              Object.assign(update, {
                availabilityContext: null,
                availabilityCursor: null,
              });
            }
          } else {
            // Lexical exact date only (shared resolver — no snapshot-anchored
            // bare day). Anchored "14" on a DATE page must not auto-accept.
            const schedule = parseScheduleIntent(patientText, kyivToday());
            if (schedule?.kind === "exact" && schedule.date != null) {
              const session = reduceBookingSession(
                { bookingDraft: bookingDraft ?? null, pendingInteraction },
                {
                  type: "service_confirm_schedule",
                  schedule: { type: "date_selected", date: schedule.date },
                  turn: state.stepCount,
                },
              );
              bookingDraft = session.bookingDraft;
              pendingInteraction = session.pendingInteraction;
            }
            // Unmatched prose on an open offer reaches the booking LLM — no
            // stem routing / catalog open from patient text.
          }
        }
        const scheduleRequest = resolveBookingScheduleRequest(
          lastPatientText(rescheduleState),
          kyivToday(),
          {
            availabilityContext: rescheduleState.availabilityContext,
            availabilityCursor: rescheduleState.availabilityCursor,
            selectedDate: bookingDraft?.selectedDate,
          },
        );
        if (bookingDraft && scheduleRequest?.kind === "exact") {
          bookingDraft = reduceBookingDraft(bookingDraft, {
            type: "schedule_requested",
            date: scheduleRequest.date,
            ...(scheduleRequest.preferredTime
              ? { preferredTime: scheduleRequest.preferredTime }
              : {}),
          });
        }
        const workingState: ClinicState = {
          ...rescheduleState,
          ...(bookingDraft !== undefined ? { bookingDraft } : {}),
          pendingInteraction,
        };
        const noteUpdate = advanceBookingNoteStep(workingState);
        Object.assign(update, noteUpdate);
        bookingDraft = (noteUpdate.bookingDraft as BookingDraft | null | undefined) ?? bookingDraft;
        if (noteUpdate.pendingInteraction !== undefined) {
          pendingInteraction = noteUpdate.pendingInteraction as typeof pendingInteraction;
        }
      }
      if (pendingInteraction !== (rescheduleState.pendingInteraction ?? null)) {
        update.pendingInteraction = pendingInteraction;
      }
      if (
        bookingDraft
        && bookingDraft.contactId != null
        && resolveContactIdentity(state.contactContext, bookingDraft.contactId).kind !== "owned"
      ) {
        bookingDraft = reduceBookingDraft(bookingDraft, { type: "contact_unresolved" });
      }
      if (bookingDraft && typeof contactId === "string" && contactId !== bookingDraft.contactId) {
        bookingDraft = reduceBookingDraft(bookingDraft, {
          type: "contact_resolved",
          contactId,
        });
      }
      if (pendingInteraction?.kind === "contact_field") {
        const patientText = lastPatientText(state).trim();
        const openField = pendingInteraction.field;
        let submitted: { field: typeof openField; value: string } | null = null;
        if (openField === "phoneNumber" && patientText.length > 0) {
          const phone = normalizeClinicPhone(patientText);
          if (phone != null) {
            submitted = { field: "phoneNumber", value: phone };
          }
        } else if (
          options?.classifyContactName
          && (openField === "firstName" || openField === "lastName")
          && patientText.length > 0
          && normalizeClinicPhone(patientText) == null
        ) {
          const classified = await options.classifyContactName({
            patientText,
            field: openField,
          });
          if (classified.kind === "name") {
            submitted = { field: openField, value: classified.value };
          }
        }
        if (submitted != null) {
          const owned = resolveContactIdentity(
            state.contactContext,
            bookingDraft?.contactId,
          );
          const session = reduceBookingSession(
            {
              bookingDraft: bookingDraft ?? null,
              pendingInteraction,
            },
            {
              type: "contact_field_submitted",
              field: submitted.field,
              value: submitted.value,
              ...(owned.kind === "owned" ? { crmContact: owned.contact } : {}),
            },
          );
          bookingDraft = session.bookingDraft;
          pendingInteraction = session.pendingInteraction;
          update.pendingInteraction = pendingInteraction;
          if (session.bookingDraft !== undefined) {
            update.bookingDraft = session.bookingDraft;
          }
        }
      }
      const blockingState: ClinicState = {
        ...state,
        bookingDraft: bookingDraft ?? null,
        pendingInteraction,
      };
      const bookingEntry = bookingEntryTransitionForTurn(blockingState);
      if (bookingEntry?.kind === "offer_replacement") {
        const meeting = bookingEntry.meeting;
        bookingDraft = reduceBookingDraft(
          bookingDraft ?? createEmptyBookingDraft(),
          {
            type: "existing_booking_detected",
            meeting: {
              id: meeting.id,
              name: meeting.name,
              dateStart: meeting.dateStart,
              dateEnd: meeting.dateEnd,
            },
          },
        );
      } else if (bookingEntry?.kind === "offer_consultation") {
        // «Записатись» or idle booking with owned contact: consultation without LLM.
        const labels = bookingOfferLabels(
          inferConversationLocaleFromText(lastPatientText(blockingState)),
        );
        const session = reduceBookingSession(
          {
            bookingDraft: bookingDraft ?? null,
            pendingInteraction: pendingInteraction ?? null,
          },
          {
            type: "service_offered",
            service: consultationService("catalog"),
            acceptLabel: labels.acceptLabel,
            chooseOtherLabel: labels.chooseOtherLabel,
          },
        );
        bookingDraft = session.bookingDraft;
        pendingInteraction = session.pendingInteraction;
        update.pendingInteraction = pendingInteraction;
      }
      if (bookingDraft) {
        update.bookingDraft = bookingDraft;
      }
    }
    return update;
  };

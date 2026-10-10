import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
} from "@personal-assistant/llm-gemini";

import { stripToolNoiseFromMessages } from "../supervisor-history.js";
import type { SupervisorContextCacheOptions } from "../supervisor.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../types.js";
import {
  availabilityCursorFromContext,
  tryAvailabilityCacheHit,
  KYIV_LOCAL_ISO_SCHEMA,
  presentAvailabilitySlotsArgsSchema,
  type AvailabilitySlotsToolArgs,
} from "../../tools/availability-tools.js";
import { normalizeAvailabilityToolArgs } from "../../tools/availability-args.js";
import { kyivToday } from "../../tools/availability-slots.js";
import {
  reconcileRequestedTime,
  resolveBookingScheduleRequest,
} from "../booking-schedule.js";
import { contactMissingFields, normalizeContactLookupResult } from "../../tools/contact-tools.js";
import { trackEvent, trackToolError } from "../../analytics/track.js";
import { PATIENT_FALLBACK_MESSAGE } from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import {
  formatBookingMeetingsContext,
  formatBookingDraftContext,
  formatContactContext,
  formatFaqCatalogChoicesContext,
  formatPlannedVisitsFlag,
  formatServicesContext,
} from "../context-blocks.js";
import { buildCachedMessages, buildUncachedMessages } from "../gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  reduceBookingDraft,
  type PendingBookingCommand,
  type BookingDraft,
} from "../booking-draft.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
  openVisitNoteInteraction,
  reduceBookingSession,
} from "../booking-session.js";
import { restorePendingInteraction } from "../booking-interaction-restore.js";
import { bookingTurnNeedsNoteOrchestrator } from "../booking-note-orchestrator.js";
import { renderBookingInteractionMessage } from "../booking-interaction-render.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
} from "../service-resolution.js";
import { tagModelFailureMessage } from "../sub-agent-messages.js";

import {
  bookingCommandContinuesAfterTools,
  bookingTurnNeedsCommandPreparation,
  freshAvailabilityValidatesSelectedSlot,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
  isPendingChatConfirmationReplay,
  normalizeMeetingMutationArgs,
  shouldRearmCancelAfterChatOther,
} from "./command-prepare.js";

import {
  BOOKING_SLOT_REQUIRED_UK,
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
  CONTACT_OWNERSHIP_REQUIRED_ERROR,
  CREATE_CONSULTATION_REQUIRED_ERROR,
  CREATE_NOTE_REQUIRED_ERROR,
  FAQ_CATALOG_SHORTCUT_LABELS,
  MEETING_MUTATION_TOOLS,
  NAME_NOT_PROVIDED_ERROR,
  PHONE_GROUNDED_TOOLS,
  PHONE_NOT_PROVIDED_ERROR,
  RESCHEDULE_STATE_REQUIRED_ERROR,
  SELECTED_SLOT_NOT_AVAILABLE_ERROR,
  SLOT_SELECTION_REQUIRED_ERROR,
  advanceBookingNoteStep,
  alreadyBookedMeetingFromMessages,
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  availabilitySlotsRanThisTurn,
  blocksConsultationWithoutAgreement,
  bookingDateAnchors,
  bookingDraftForTurn,
  bookingMutationNeedsModelRecovery,
  captureAvailabilityFromMessages,
  captureLatestToolContext,
  captureServicesFromMessages,
  classifyMeetingMutationToolMessage,
  createContactPhoneMatchesOccupiedCandidate,
  crmWriteDirtiesPrefetch,
  humanProvidedName,
  humanProvidedPhone,
  lastPatientText,
  latestCreateMeetingError,
  matchAvailabilityDay,
  matchingCatalogRows,
  meetingMutationClearsAvailability,
  meetingMutationIsHitlDecline,
  noteStepBlocksCreate,
  phoneCandidateCanBeLinked,
  rescheduleAvailabilityArgsFromBookingContext,
  rescheduleTargetFromBookingContext,
  resetBookingNoteState,
  resolveContactIdentity,
  resolveFaqCatalogChoices,
  terminalMeetingMutationOutcome,
  toolRanThisTurn,
} from "./shared.js";

import { coerceAvailabilityToolCalls } from "./tool-call-coercion.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;

export const commandPrepareNodeName = (agentId: string): string => `${agentId}__command_prepare`;

export const llmNodeName = (agentId: string): string => `${agentId}__llm`;

export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;

export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

export const mutationFinalizeNodeName = (agentId: string): string => `${agentId}__mutation_finalize`;

export type CreateAgentLoopOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  contextCache?: SupervisorContextCacheOptions;
};

export type CreateAgentPrepareOptions = {
  partitionCandidates?: PartitionServiceCandidates;
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
                choices,
              },
            );
            update.pendingInteraction = session.pendingInteraction;
          }
        }
        // Unmatched text (comparisons, «який краще?», «не знаю», prices, …)
        // reaches the FAQ model with the open catalog context.
      } else if (interaction?.kind === "service_confirm") {
        // Free-text brand/family pick after offer_consultation (e.g. «botox»)
        // must reopen catalog chips — otherwise Так/Обрати stays stuck.
        const offerMatch = interpretInteractionReply(interaction, patientText);
        if (offerMatch.kind !== "choice") {
          const services = state.servicesContext?.list ?? [];
          const matchingRows = matchingCatalogRows(patientText, services);
          if (matchingRows.length === 1) {
            const row = matchingRows[0]!;
            handledCatalogChoice = true;
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
          } else if (matchingRows.length > 1) {
            const matchingIds = matchingRows.map((row) => row.id);
            const choices = await resolveFaqCatalogChoices({
              services,
              remainingIds: matchingIds,
              utterance: patientText,
              selectedLabel: patientText,
              ...(options?.partitionCandidates != null
                ? { partitionCandidates: options.partitionCandidates }
                : {}),
            });
            if (choices.length > 0) {
              handledCatalogChoice = true;
              const session = reduceBookingSession(
                {
                  bookingDraft: state.bookingDraft ?? null,
                  pendingInteraction: interaction,
                },
                {
                  type: "service_candidates_opened",
                  utterance: patientText,
                  owner: "faq",
                  choices,
                },
              );
              update.pendingInteraction = session.pendingInteraction;
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
      // Browse open: «Обрати іншу процедуру» (not «Послуги») — partition all CRM ids.
      if (
        !handledCatalogChoice
        && FAQ_CATALOG_SHORTCUT_LABELS.has(patientText)
        && (state.servicesContext?.list.length ?? 0) > 0
      ) {
        const services = state.servicesContext!.list;
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
              choices,
            },
          );
          update.pendingInteraction = session.pendingInteraction;
        }
      }
    }
    if (agentId === BOOKING_AGENT_ID) {
      const restoredInteraction = restorePendingInteraction({
        bookingDraft: state.bookingDraft,
        pendingInteraction: state.pendingInteraction,
        availabilityContext: state.availabilityContext,
        contactContext: state.contactContext,
        bookingContext: state.bookingContext,
        lastHandoff: state.lastHandoff,
        prefetchFresh: state.prefetchDirty !== true && state.prefetchFetchedAt != null,
      });
      if (
        restoredInteraction != null
        && state.pendingInteraction == null
      ) {
        update.pendingInteraction = restoredInteraction;
      }
      const contactIdentity = resolveContactIdentity(state.contactContext);
      const contactId = contactIdentity.kind === "owned" ? contactIdentity.contactId : null;
      // Fold all events from this turn into one local aggregate. In particular,
      // service acceptance and the date/time/note ladder must never each reduce
      // from the stale checkpoint and then overwrite one another.
      const effectivePending =
        (update.pendingInteraction as typeof state.pendingInteraction | undefined)
        ?? state.pendingInteraction;
      // Reschedule is seeded by the supervisor (pending_reschedule / chip / sticky).
      // Prepare only fills a missing target on an already-reschedule draft.
      const rescheduleTarget = state.bookingDraft?.mode === "reschedule"
        ? rescheduleTargetFromBookingContext(state)
        : null;
      const startedReschedule =
        state.bookingDraft?.mode === "reschedule"
        && state.bookingDraft.rescheduleTarget == null
        && rescheduleTarget != null
          ? reduceBookingDraft(state.bookingDraft, {
              type: "reschedule_started",
              meeting: rescheduleTarget,
            })
          : undefined;
      const rescheduleState = {
        ...(startedReschedule
          ? { ...state, bookingDraft: startedReschedule }
          : state),
        pendingInteraction: effectivePending ?? state.pendingInteraction ?? null,
      };
      // Orch ownership is inbound-only so a slot pick that opens visit_note
      // this turn still reaches the booking LLM. Skip utterance-driven draft
      // mutations when the orch already owns the turn.
      const queueNoteOrch = bookingTurnNeedsNoteOrchestrator(rescheduleState);
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
          } else {
            const schedule = resolveBookingScheduleRequest(
              patientText,
              kyivToday(),
              {
                availabilityContext: rescheduleState.availabilityContext,
                availabilityCursor: rescheduleState.availabilityCursor,
                selectedDate: bookingDraft?.selectedDate,
              },
            );
            const isAvailabilityContinuation =
              schedule != null || /\b\d{1,2}(?::\d{2})?\b/.test(patientText);
            if (isAvailabilityContinuation) {
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
              } else {
                const session = reduceBookingSession(
                  { bookingDraft: bookingDraft ?? null, pendingInteraction },
                  { type: "interaction_choice", choiceId: "accept" },
                );
                bookingDraft = session.bookingDraft;
                pendingInteraction = session.pendingInteraction;
              }
            }
          }
        } else if (bookingDraft?.mode !== "reschedule") {
          bookingDraft = bookingDraftForTurn(rescheduleState) ?? bookingDraft;
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
      if (bookingDraft) {
        update.bookingDraft = bookingDraft;
      }
    }
    return update;
  };

export const createAgentLlmNode = (options: CreateAgentLoopOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;
  const cache = options.contextCache;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);
  const displayName = cache?.displayName ?? `clinic-${agent.id}`;
  const allowedToolNames = new Set(tools.map((tool) => tool.name));

  const invokeUncached = async (
    staticPrompt: string,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) =>
    boundModel.invoke(buildUncachedMessages(staticPrompt, dynamic, history), config);

  const invokeCached = async (
    handle: ContextCacheHandle,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) => {
    const cachedModel = createCachedGeminiModel(cache!.apiKey, cache!.modelName, handle);
    // Tools and system instruction live in CachedContent — must not be sent again on generateContent.
    return cachedModel.invoke(buildCachedMessages(dynamic, history), config);
  };

  const cacheSpec = (staticPrompt: string) => ({
    modelName: cache!.modelName,
    staticSystemInstruction: staticPrompt,
    tools,
    displayName,
  });

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    if (hasPendingToolCalls(state.agentMessages)) {
      return { stepCount: state.stepCount };
    }

    const last = state.agentMessages[state.agentMessages.length - 1];
    const isContinuation = last instanceof ToolMessage;
    const stepCount = isContinuation ? state.stepCount + 1 : 1;

    // `Note step required` is a deterministic invariant guard, not new model
    // context. Repair presentation from canonical state without another model
    // pass, which otherwise repeats the same note question indefinitely.
    if (
      agent.id === BOOKING_AGENT_ID
      && latestCreateMeetingError(state.agentMessages) === CREATE_NOTE_REQUIRED_ERROR
    ) {
      const noteInteraction = openVisitNoteInteraction();
      const slotMissing = authoritativeSelectedSlot(state) == null;
      const rendered = slotMissing
        ? new AIMessage(BOOKING_SLOT_REQUIRED_UK)
        : renderBookingInteractionMessage(noteInteraction);
      return {
        agentMessages: [rendered],
        ...(slotMissing
          ? {}
          : { pendingInteraction: noteInteraction }),
        stepCount,
      };
    }

    const staticPrompt = agent.systemPrompt.trim();
    const dynamicParts = [
      formatSystemMetadata(new Date(), { runtimeAgent: agent.name }).trim(),
      agent.id === BOOKING_AGENT_ID ? formatContactContext(state.contactContext) : "",
      agent.id === BOOKING_AGENT_ID
        ? formatBookingMeetingsContext(state.bookingContext)
        : formatPlannedVisitsFlag(state.bookingContext),
    ];
    // Full days[] lives in the slots tool result / checkpoint — do not also bill Gemini for it.
    // BookingDraft is the single compact projection of the selected slot.
    if (agent.id === BOOKING_AGENT_ID) {
      dynamicParts.push(formatBookingDraftContext(state.bookingDraft));
    }
    if (
      (agent.id === FAQ_AGENT_ID || agent.id === BOOKING_AGENT_ID)
      && !toolRanThisTurn(state.agentMessages, "list_services")
    ) {
      dynamicParts.push(formatServicesContext(state.servicesContext));
    }
    if (
      agent.id === FAQ_AGENT_ID
      && state.pendingInteraction?.kind === "service_candidate"
      && state.pendingInteraction.owner === "faq"
    ) {
      dynamicParts.push(
        formatFaqCatalogChoicesContext(state.pendingInteraction.choices),
      );
    }
    const dynamic = dynamicParts.filter((part) => part.length > 0).join("\n\n");

    try {
      let handle: ContextCacheHandle | null = null;
      if (cache) {
        handle = await cache.manager.getOrCreate(cacheSpec(staticPrompt));
      }

      let response: AIMessage;
      if (handle) {
        try {
          response = (await invokeCached(
            handle,
            dynamic,
            state.agentMessages,
            config,
          )) as AIMessage;
        } catch (error) {
          if (!isCachedContentNotFoundError(error)) {
            throw error;
          }
          cache!.manager.invalidate(handle.cacheName);
          const recreated = await cache!.manager.getOrCreate(cacheSpec(staticPrompt));
          response = (recreated
            ? await invokeCached(recreated, dynamic, state.agentMessages, config)
            : await invokeUncached(staticPrompt, dynamic, state.agentMessages, config)) as AIMessage;
        }
      } else {
        response = (await invokeUncached(
          staticPrompt,
          dynamic,
          state.agentMessages,
          config,
        )) as AIMessage;
      }

      return {
        agentMessages: [coerceAvailabilityToolCalls(response, state, agent.id, allowedToolNames)],
        stepCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[clinic-${agent.id}] model call failed:`, message);
      return {
        agentMessages: [tagModelFailureMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE))],
        stepCount,
      };
    }
  };
};

export const createAgentToolsNode = (
  tools: StructuredToolInterface[],
  agentId?: string,
) => {
  const toolNode = new ToolNode(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const agentMessages = state.agentMessages ?? [];
    let lastAiIndex = -1;
    for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
      const message = agentMessages[index];
      if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
        lastAiIndex = index;
        break;
      }
    }

    const synthetic: ToolMessage[] = [];
    const remainingCalls: NonNullable<AIMessage["tool_calls"]> = [];
    let noteStatusUpdate: ClinicStateUpdate = {};
    let availabilityPagedThisTurn = availabilitySlotsRanThisTurn(agentMessages);

    if (lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      for (const call of lastAi.tool_calls ?? []) {
        if (
          agentId === BOOKING_AGENT_ID
          && call.name === "create_meeting"
          && !blocksConsultationWithoutAgreement(agentId, call, state)
          && noteStepBlocksCreate(authoritativeNoteStatus(state))
        ) {
          noteStatusUpdate = state.bookingDraft
            ? {
                bookingDraft: reduceBookingDraft(state.bookingDraft, {
                  type: "note_status",
                  status: "awaiting",
                }),
              }
            : {};
          trackEvent("booking_create_blocked_note", {
            phase: authoritativeNoteStatus(state),
          });
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: CREATE_NOTE_REQUIRED_ERROR,
                hint:
                  "Ask the optional visit-note question once (STEP INTENT) with the skip shortcut. Do not call create_meeting until the patient skips, declines, or shares a note.",
              }),
              tool_call_id: call.id ?? "",
              name: "create_meeting",
            }),
          );
          continue;
        }

        if (
          blocksConsultationWithoutAgreement(agentId, call, state)
        ) {
          trackEvent("booking_consultation_guard", {
            phase: state.bookingDraft?.phase ?? "service",
            outcome: "blocked",
          });
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: CREATE_CONSULTATION_REQUIRED_ERROR,
                hint:
                  "serviceId is the consultation id but the patient has not explicitly agreed to «Консультація» (Так after a consultation offer, or they named consultation). Do not present times or book consultation. If they named another procedure/family, that belongs to FAQ catalog browse — do not substitute consultation.",
              }),
              tool_call_id: call.id ?? "",
              name: call.name,
            }),
          );
          continue;
        }

        if (
          agentId === BOOKING_AGENT_ID
          && call.name === "create_meeting"
          && authoritativeSelectedSlot(state) == null
          && (state.availabilityContext?.days.filter((day) => day.slots.length > 0).length ?? 0) > 1
        ) {
          trackToolError(call.name, SLOT_SELECTION_REQUIRED_ERROR);
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: SLOT_SELECTION_REQUIRED_ERROR,
                hint:
                  "Ask the patient to choose a day and then a time from the current availability. Do not invent a date.",
              }),
              tool_call_id: call.id ?? "",
              name: call.name,
            }),
          );
          continue;
        }

        if (PHONE_GROUNDED_TOOLS.has(call.name)) {
          const rawPhone = (call.args ?? {}).phoneNumber;
          if (typeof rawPhone === "string" && rawPhone.trim() !== "") {
            const wanted = normalizeClinicPhone(rawPhone);
            if (
              wanted != null
              && !humanProvidedPhone(state.messages ?? [], wanted)
            ) {
              trackToolError(call.name, PHONE_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: PHONE_NOT_PROVIDED_ERROR,
                    hint:
                      "Ask the patient for their clinic phone, then retry with the number they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }

          if (call.name === "create_contact" || call.name === "update_contact") {
            const args = call.args ?? {};
            const nameFields = ["firstName", "lastName"] as const;
            const invented = nameFields.find((field) => {
              const raw = args[field];
              return (
                typeof raw === "string"
                && raw.trim() !== ""
                && !humanProvidedName(state.messages ?? [], raw)
              );
            });
            if (invented) {
              trackToolError(call.name, NAME_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: NAME_NOT_PROVIDED_ERROR,
                    hint:
                      "Ask the patient for their name, then retry with the value they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }

          if (
            call.name === "create_contact"
            && createContactPhoneMatchesOccupiedCandidate(
              resolveContactIdentity(state.contactContext),
              (call.args ?? {}).phoneNumber,
            )
          ) {
            trackToolError(call.name, CONTACT_LINK_CANDIDATE_REQUIRED_ERROR);
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
                  hint:
                    "This phone belongs to another Telegram account. Ask for a different number; do not create a Contact with it.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
        }

        if (call.name === "create_meeting" || call.name === "reschedule_meeting") {
          call.args = normalizeMeetingMutationArgs(state, call);
          if (
            call.name === "create_meeting"
            && resolveContactIdentity(
              state.contactContext,
              state.bookingDraft?.contactId,
            ).kind !== "owned"
          ) {
            trackToolError(call.name, CONTACT_OWNERSHIP_REQUIRED_ERROR);
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: CONTACT_OWNERSHIP_REQUIRED_ERROR,
                  hint:
                    "Resolve a Telegram-owned Contact for the current patient before creating the meeting.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
          const chatConfirmationReplay = isPendingChatConfirmationReplay(
            state,
            call.name === "create_meeting" ? "create" : "reschedule",
            call.args,
          );
          if (call.name === "reschedule_meeting") {
            const draft = state.bookingDraft;
            const normalizedArgs = call.args as { dateStart?: unknown; dateEnd?: unknown };
            const datesAreValid =
              KYIV_LOCAL_ISO_SCHEMA.safeParse(normalizedArgs.dateStart).success
              && KYIV_LOCAL_ISO_SCHEMA.safeParse(normalizedArgs.dateEnd).success;
            if (
              datesAreValid
              && (
                draft?.mode !== "reschedule"
                || draft.rescheduleTarget == null
                || draft.selectedSlot == null
                || draft.pendingCommand?.action !== "reschedule"
                || (!chatConfirmationReplay && !freshAvailabilityValidatesSelectedSlot(state))
              )
            ) {
              trackToolError(call.name, RESCHEDULE_STATE_REQUIRED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: RESCHEDULE_STATE_REQUIRED_ERROR,
                    hint: "Select a slot from fresh availability before rescheduling.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }
          const args = call.args as {
            dateStart?: string;
            dateEnd?: string;
            serviceId?: string;
            contactId?: string;
          };
          const selectedSlot = authoritativeSelectedSlot(state);
          const requiresFreshCreateValidation = call.name === "create_meeting"
            && state.bookingDraft?.pendingCommand?.action === "create"
            && !chatConfirmationReplay;
          if (requiresFreshCreateValidation && !freshAvailabilityValidatesSelectedSlot(state)) {
            trackToolError(call.name, SELECTED_SLOT_NOT_AVAILABLE_ERROR);
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: SELECTED_SLOT_NOT_AVAILABLE_ERROR,
                  hint: "Refresh availability and offer another slot before booking.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
          if (selectedSlot) {
            const availability = state.bookingDraft?.selectedSlot
              ? state.availabilityContext
              : null;
            const selectedDay = availability?.days.find(
              (day) => day.date === selectedSlot.dateStart.slice(0, 10),
            );
            const snapshotMatchesService = availability == null
              || availability.serviceId == null
              || availability.serviceId === state.bookingDraft?.serviceAcceptance?.service.id;
            const selectedSlotStillAvailable = snapshotMatchesService
              && (availability == null
                || selectedDay == null
                ? availability == null
                : selectedDay.slots.some((slot) =>
                  slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
                ));
            if (!selectedSlotStillAvailable) {
              trackToolError(call.name, SELECTED_SLOT_NOT_AVAILABLE_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: SELECTED_SLOT_NOT_AVAILABLE_ERROR,
                    hint: "Refresh availability and offer another slot before booking.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }
          if (
            (call.name === "reschedule_meeting" || selectedSlot == null)
            && (
              !KYIV_LOCAL_ISO_SCHEMA.safeParse(args.dateStart).success
              || !KYIV_LOCAL_ISO_SCHEMA.safeParse(args.dateEnd).success
            )
          ) {
            trackToolError(call.name, "Invalid meeting datetime");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Invalid meeting datetime",
                  hint:
                    "Use YYYY-MM-DDTHH:mm:ss from <booking_draft> or present_availability_slots.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
        }

        if (call.name === "present_availability_slots") {
          // Own paging cursors from checkpoint — the model chooses semantic direction,
          // but must not invent calendar boundaries.
          const rawArgs = (call.args ?? {}) as AvailabilitySlotsToolArgs;
          const runtimeRequest = resolveBookingScheduleRequest(lastPatientText(state), kyivToday(), {
            availabilityContext: state.availabilityContext,
            availabilityCursor: state.availabilityCursor,
            selectedDate: state.bookingDraft?.selectedDate,
          }) ?? (
            state.bookingDraft?.selectedDate
            && rawArgs.direction === "exact"
            && rawArgs.date === state.bookingDraft.selectedDate
              ? { kind: "exact" as const, date: state.bookingDraft.selectedDate }
              : null
          );
          const rescheduleArgs = rescheduleAvailabilityArgsFromBookingContext(
            state,
            rawArgs as Record<string, unknown>,
          );
          const dayPick = matchAvailabilityDay(
            lastPatientText(state),
            state.availabilityContext?.days ?? [],
          );
          const args = normalizeAvailabilityToolArgs({
            args: (rescheduleArgs ?? rawArgs) as AvailabilitySlotsToolArgs,
            runtimeRequest,
            offeredDayDate: dayPick?.date ?? null,
            availabilityContext: state.availabilityContext,
            availabilityCursor: state.availabilityCursor,
            ...(state.bookingDraft?.serviceAcceptance?.service.durationMinutes != null
              ? { serviceDurationMinutes: state.bookingDraft.serviceAcceptance.service.durationMinutes }
              : {}),
            availabilityPagedThisTurn,
            anchors: bookingDateAnchors(state),
          });
          call.args = args;
          if (args.direction === "exact" && !args.date) {
            trackToolError(call.name, "Exact availability date missing");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Exact availability date missing",
                  hint: "Resolve the patient's named calendar date before searching availability.",
                }),
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
          const parsed = presentAvailabilitySlotsArgsSchema.safeParse(args);
          if (!parsed.success) {
            trackToolError(call.name, "Invalid availability arguments");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Invalid availability arguments",
                  hint:
                    "Use YYYY-MM-DD for date/afterDate/beforeDate/startDate; durationMinutes 15–180.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
          call.args = parsed.data;
          const hit = tryAvailabilityCacheHit(state.availabilityContext, parsed.data);
          if (hit) {
            trackEvent("availability_cache_hit", {
              outcome: "success",
              kind: hit.kind,
              ...(typeof parsed.data.date === "string" ? { date: parsed.data.date } : {}),
            });
            synthetic.push(
              new ToolMessage({
                content: hit.json,
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
          if (args.direction === "earlier" || args.direction === "later") {
            availabilityPagedThisTurn = true;
          }
        }

        if (call.name === "link_telegram_to_contact") {
          const args = call.args;
          const contactId = args && typeof args === "object" && !Array.isArray(args)
            && typeof (args as { contactId?: unknown }).contactId === "string"
            ? (args as { contactId: string }).contactId
            : null;
          if (
            contactId == null
            || !phoneCandidateCanBeLinked(resolveContactIdentity(state.contactContext), contactId)
          ) {
            trackToolError(call.name, CONTACT_LINK_CANDIDATE_REQUIRED_ERROR);
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
                  hint:
                    "Link only the Contact returned by find_contact_by_phone for this patient.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
        }

        remainingCalls.push(call);
      }
    }

    let toolResultMessages: BaseMessage[] = [];
    if (remainingCalls.length > 0 && lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      const originalCalls = lastAi.tool_calls ?? [];
      const messagesForTools =
        remainingCalls.length === originalCalls.length
          ? agentMessages
          : [
              ...agentMessages.slice(0, lastAiIndex),
              new AIMessage({
                content: lastAi.content,
                tool_calls: remainingCalls,
                additional_kwargs: lastAi.additional_kwargs,
                response_metadata: lastAi.response_metadata,
                id: lastAi.id,
              } as ConstructorParameters<typeof AIMessage>[0]),
              ...agentMessages.slice(lastAiIndex + 1),
            ];
      const result = await (
        toolNode as unknown as {
          run(
            input: { messages: BaseMessage[] },
            config?: RunnableConfig,
          ): Promise<{ messages: BaseMessage[] }>;
        }
      ).run({ messages: messagesForTools }, config);
      toolResultMessages = result.messages;
    }

    const resultMessages = [...synthetic, ...toolResultMessages];
    const replacementCancellationResult =
      state.bookingDraft?.replacement?.status === "cancelling"
      && resultMessages.some(
        (message) => message instanceof ToolMessage && message.name === "cancel_meeting",
      );
    const update: ClinicStateUpdate = {
      agentMessages: resultMessages,
      ...noteStatusUpdate,
      ...(replacementCancellationResult
        ? { pendingCancellationPurpose: "replacement" as const }
        : {}),
    };

    const authorizationFailure = resultMessages.some((message) => {
      if (!(message instanceof ToolMessage) || !MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
        return false;
      }
      return asJsonRecord(extractMessageTextContent(message.content).trim())?.error === "Not authorized";
    });
    if (authorizationFailure) {
      // The contact must be linked before this mutation can be retried. Clear
      // every projection that could reconstruct the rejected command so the
      // next route returns to identity resolution instead of replaying it.
      if (state.bookingDraft) {
        update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
          type: "contact_unresolved",
        });
      }
      update.contactContext = null;
      update.bookingContext = null;
      update.prefetchDirty = true;
    }

    const pendingCommand = resultMessages
      .map((message) => {
        if (!(message instanceof ToolMessage)) {
          return null;
        }
        const record = asJsonRecord(extractMessageTextContent(message.content).trim());
        const draft = asJsonRecord(record?.draft);
        const command = asJsonRecord(draft?.command);
        if (
          record?.awaitingConfirmation !== true
          || (command?.action !== "create"
            && command?.action !== "reschedule"
            && command?.action !== "replace"
            && command?.action !== "cancel")
          || !asJsonRecord(command.payload)
        ) {
          return null;
        }
        return {
          action: command.action,
          payload: asJsonRecord(command.payload)!,
        } satisfies PendingBookingCommand;
      })
      .find((command): command is PendingBookingCommand => command != null);
    const commandToPersist = pendingCommand
      && state.bookingDraft?.pendingCommand
      && state.bookingDraft.pendingCommand.action === pendingCommand.action
      ? state.bookingDraft.pendingCommand
      : pendingCommand;
    if (commandToPersist && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "command_prepared",
        command: commandToPersist,
      });
    }

    const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
    if (conflictMeeting && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "existing_booking_detected",
        meeting: conflictMeeting,
      });
    }

    const cancelCommitted = resultMessages.some(
      (message) =>
        message instanceof ToolMessage
        && message.name === "cancel_meeting"
        && classifyMeetingMutationToolMessage(message) === "committed",
    );
    const cancelDeclined = resultMessages.some(
      (message) =>
        message instanceof ToolMessage
        && message.name === "cancel_meeting"
        && meetingMutationIsHitlDecline(message),
    );

    if (meetingMutationClearsAvailability(resultMessages)) {
      update.availabilityContext = null;
      update.availabilityCursor = null;
      // REPLACE cancel-and-rebook: keep selectedSlot + note so create_meeting can reuse them.
      // Only skip reset when cancel_meeting is the sole committed mutation this turn.
      const committed = resultMessages.filter(
        (message): message is ToolMessage =>
          message instanceof ToolMessage
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
      const cancelOnlyCommitted =
        committed.length > 0 && committed.every((message) => message.name === "cancel_meeting");
      if (cancelCommitted && state.bookingDraft?.replacement?.status === "cancelling") {
        update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
          type: "cancel_existing_completed",
        });
      } else if (cancelDeclined && state.bookingDraft?.replacement?.status === "cancelling") {
        Object.assign(update, closedBookingSessionUpdate());
      } else if (!cancelOnlyCommitted) {
        Object.assign(update, resetBookingNoteState(state));
        const mutationFailed = resultMessages.some(
          (message) =>
            message instanceof ToolMessage
            && classifyMeetingMutationToolMessage(message) === "failed",
        );
        const mutationDeclined = resultMessages.some(
          (message) =>
            message instanceof ToolMessage
            && (message.name === "create_meeting" || message.name === "reschedule_meeting")
            && meetingMutationIsHitlDecline(message),
        );
        const mutationCommitted = committed.length > 0;
        if (state.bookingDraft && (mutationFailed || mutationDeclined) && !mutationCommitted) {
          // A CRM race/error or a patient-declined booking invalidates only the
          // selected slot. Keep the accepted service and note so a later
          // availability search still uses the service duration.
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft,
              pendingInteraction: state.pendingInteraction ?? null,
            },
            { type: "draft_event", event: { type: "slot_invalidated" } },
          );
          update.bookingDraft = session.bookingDraft;
          update.pendingInteraction = session.pendingInteraction;
        } else if (state.bookingDraft) {
          Object.assign(update, closedBookingSessionUpdate());
        }
      }
      if (
        resultMessages.some(
          (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
        )
      ) {
        trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
      }
    } else {
      const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
      if (capturedAvailability !== undefined) {
        const acceptedService = state.bookingDraft?.serviceAcceptance;
        const bookingAvailability = capturedAvailability != null
          && acceptedService?.status === "accepted"
          ? { ...capturedAvailability, serviceId: acceptedService.service.id }
          : capturedAvailability;
        update.availabilityContext = bookingAvailability;
        update.availabilityCursor = availabilityCursorFromContext(bookingAvailability);
        const reconciliation = reconcileRequestedTime(state.bookingDraft, bookingAvailability);
        if (reconciliation.kind === "matched" && state.bookingDraft) {
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft,
              pendingInteraction: state.pendingInteraction ?? null,
            },
            { type: "slot_selected", slot: reconciliation.slot },
          );
          update.bookingDraft = session.bookingDraft;
          update.pendingInteraction = session.pendingInteraction;
        } else if (reconciliation.kind === "unavailable" && state.bookingDraft) {
          update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
            type: "requested_time_unavailable",
          });
        }
        const bookingDraft = (update.bookingDraft as BookingDraft | undefined) ?? state.bookingDraft;
        const selectedDate = bookingDraft?.selectedDate;
        const selectedSlot = bookingDraft?.selectedSlot ?? null;
        const selectedDay = selectedDate == null
          ? undefined
          : bookingAvailability?.days.find((day) => day.date === selectedDate);
        const snapshotMatchesService = bookingAvailability == null
          || bookingAvailability.serviceId == null
          || bookingAvailability.serviceId === bookingDraft?.serviceAcceptance?.service.id;
        const selectedSlotStillAvailable = snapshotMatchesService
          && (selectedSlot == null
            || selectedDay?.slots.some((slot) =>
              slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
            ) === true);
        if (
          selectedDate != null
          && (
            bookingAvailability == null
            || selectedDay?.slots.length === 0
            || !selectedSlotStillAvailable
          )
        ) {
          if (bookingDraft) {
            const session = reduceBookingSession(
              {
                bookingDraft,
                pendingInteraction:
                  (update.pendingInteraction as typeof state.pendingInteraction | undefined)
                  ?? state.pendingInteraction
                  ?? null,
              },
              {
                type: "draft_event",
                event: {
                  type: "slot_invalidated",
                  keepDate: selectedDay?.slots.length !== 0,
                },
              },
            );
            update.bookingDraft = session.bookingDraft;
            update.pendingInteraction = session.pendingInteraction;
          }
        }
      }
    }

    const capturedServices = captureServicesFromMessages(resultMessages);
    if (capturedServices !== undefined) {
      update.servicesContext = capturedServices;
    }

    const found = captureLatestToolContext(
      resultMessages,
      "find_contact_by_phone",
      normalizeContactLookupResult,
    );
    if (found && !found.error && found.contacts.length > 0) {
      update.contactContext = { ...found, ownership: "phone" };
    }

    let projectedBookingDraft = Object.prototype.hasOwnProperty.call(update, "bookingDraft")
      ? (update.bookingDraft as BookingDraft | null)
      : state.bookingDraft;

    for (const message of resultMessages) {
      if (!(message instanceof ToolMessage)) {
        continue;
      }
      if (
        message.name !== "create_contact"
        && message.name !== "link_telegram_to_contact"
        && message.name !== "update_contact"
      ) {
        continue;
      }
      if (authorizationFailure) {
        continue;
      }
      const record = asJsonRecord(extractMessageTextContent(message.content).trim());
      if (!record || typeof record.error === "string") {
        continue;
      }
      const call = agentMessages
        .filter((candidate): candidate is AIMessage => candidate instanceof AIMessage)
        .flatMap((candidate) => candidate.tool_calls ?? [])
        .find((candidate) => candidate.id === message.tool_call_id);
      const args = call?.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? call.args as Record<string, unknown>
        : {};
      const resolvedContactId = typeof record.id === "string" && record.id.length > 0
        ? record.id
        : null;
      const requestedContactId = message.name === "link_telegram_to_contact"
        ? args.contactId
        : message.name === "update_contact"
          ? args.contactId
          : null;
      if (
        resolvedContactId == null
        || ((message.name === "link_telegram_to_contact" || message.name === "update_contact")
          && resolvedContactId !== requestedContactId)
      ) {
        continue;
      }
      const previous = (update.contactContext as ClinicState["contactContext"] | undefined)
        ?? state.contactContext;
      const previousRow = previous?.contacts.find((contact) => contact.id === resolvedContactId) ?? {};
      if (message.name === "update_contact" && Object.keys(previousRow).length === 0) {
        continue;
      }
      const createdRow = message.name === "create_contact"
        ? {
            ...previousRow,
            id: resolvedContactId,
            ...(typeof args.firstName === "string" ? { firstName: args.firstName } : {}),
            ...(typeof args.lastName === "string" ? { lastName: args.lastName } : {}),
            ...(typeof args.phoneNumber === "string" ? { phoneNumber: args.phoneNumber } : {}),
          }
        : message.name === "link_telegram_to_contact"
          ? { ...previousRow, id: resolvedContactId }
          : {
              ...previousRow,
              id: resolvedContactId,
              ...(typeof args.firstName === "string" ? { firstName: args.firstName } : {}),
              ...(typeof args.lastName === "string" ? { lastName: args.lastName } : {}),
              ...(typeof args.phoneNumber === "string" ? { phoneNumber: args.phoneNumber } : {}),
            };
      const ownership = message.name === "create_contact" || message.name === "link_telegram_to_contact"
        ? "telegram" as const
        : previous?.ownership;
      update.contactContext = {
        ...(ownership ? { ownership } : {}),
        contacts: [{ ...createdRow, missingFields: contactMissingFields(createdRow) }],
      };
      if (projectedBookingDraft) {
        projectedBookingDraft = reduceBookingDraft(projectedBookingDraft, {
          type: "contact_resolved",
          contactId: resolvedContactId,
        });
        update.bookingDraft = projectedBookingDraft;
      }
    }

    if (crmWriteDirtiesPrefetch(resultMessages)) {
      update.prefetchDirty = true;
    }

    return update;
  };
};

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
  commandPrepareName?: string,
): string => {
  // Cancel chat-other re-arm outranks a model mutation call during unresolved
  // confirm (command_prepare replaces it). Other agents still finalize.
  if (
    commandPrepareName
    && hasMutationCallDuringUnresolvedConfirmation(state)
    && !shouldRearmCancelAfterChatOther(state)
  ) {
    return finalizeName;
  }

  // Runtime-owned booking transitions outrank both model text and the model's
  // step budget. Once canonical state is ready, no LLM-authored terminal claim
  // is eligible for finalization.
  if (commandPrepareName && bookingTurnNeedsCommandPreparation(state)) {
    return commandPrepareName;
  }

  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    if (commandPrepareName) {
      return commandPrepareName;
    }
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentPrepare = (
  state: ClinicState,
  llmName: string,
  commandPrepareName?: string,
  noteOrchestratorName?: string,
): string => {
  if (noteOrchestratorName && state.noteOrchQueued) {
    return noteOrchestratorName;
  }
  return commandPrepareName && bookingTurnNeedsCommandPreparation(state)
    ? commandPrepareName
    : llmName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
  mutationFinalizeName?: string,
  commandPrepareName?: string,
  noteOrchestratorName?: string,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  if (bookingMutationNeedsModelRecovery(state)) {
    return llmName;
  }

  if (mutationFinalizeName && terminalMeetingMutationOutcome(state) != null) {
    return mutationFinalizeName;
  }

  if (commandPrepareName && bookingCommandContinuesAfterTools(state)) {
    return commandPrepareName;
  }

  if (
    noteOrchestratorName
    && hasPendingConfirmationChatOther(state)
    && bookingTurnNeedsNoteOrchestrator(state)
  ) {
    return noteOrchestratorName;
  }

  return llmName;
};

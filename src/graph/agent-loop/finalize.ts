import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, Overwrite } from "@langchain/langgraph";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
  type ClinicHandoffStatus,
} from "../types.js";
import {
  formatKyivDateTimeLabel,
  formatKyivDayLabel,
  kyivToday,
} from "../../tools/availability-slots.js";
import { trackEvent } from "../../analytics/track.js";
import {
  BOOKING_AWAITING_CONFIRM_UK,
  BOOKING_CONTACT_SAVE_FAILED_UK,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_REPLACE_MENU,
  BOOKING_SCHEDULE_RESELECT_UK,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  MAIN_MENU_GREETING_UK,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  alreadyBookedReplaceReplyUk,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractReplyButtons,
} from "../../shared/message-content.js";
import { claimsOutcome } from "../../shared/outcome-claims.js";
import { clearPendingConfirmForRuntime } from "../../tools/meeting-confirm.js";
import type { ServicesContext } from "../../tools/service-tools.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  bookingDraftCanPresentAvailability,
  effectiveBookingContactDetails,
  nextMissingContactField,
  reduceBookingDraft,
} from "../booking-draft.js";
import { meetingServiceLabel } from "../context-blocks.js";
import {
  openCatalogFromFreeText,
  openRootFaqCatalog,
} from "../booking-entry-policy.js";
import {
  consultationService,
  isBookingOwnedInteraction,
  openVisitNoteInteraction,
  openVisitReplacementInteraction,
  reduceBookingSession,
  type DateSelectInteraction,
  type PendingInteraction,
  type TimeSelectInteraction,
} from "../booking-session.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../booking-interaction-render.js";
import {
  faqCatalogIntroFromModel,
  renderFaqCatalogReply,
} from "../faq-catalog.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../service-resolution.js";
import { isModelFailureMessage, tagRuntimeAgentMessage } from "../sub-agent-messages.js";

import {
  applyMutationChatOtherCleanup,
  hasMutationCallDuringUnresolvedConfirmation,
  hasPendingConfirmationChatOther,
} from "./command-prepare.js";

import {
  createAgentMutationFinalizeNode,
  defaultMenuHasVisit,
} from "./mutation-finalize.js";

import {
  CREATE_NOTE_REQUIRED_ERROR,
  isFaqServicesGuideLabel,
  SLOT_JUST_TAKEN_PREFIX,
  alreadyBookedMeetingFromMessages,
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  availabilityOfferFromToolTurn,
  availabilityRecoveryOffer,
  bookingOutcomeRiskState,
  classifyMeetingMutationToolMessage,
  createMeetingAlreadyBooked,
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
  lastPatientText,
  latestCreateMeetingError,
  meetingMutationIsHitlDecline,
  offeredServiceForTurn,
  phoneCandidateHasLinkableRow,
  resolveAvailabilityOffer,
  resolveContactIdentity,
  terminalContactWriteOutcome,
  terminalMeetingMutationOutcome,
} from "./shared.js";

/** Prefix when REPLACE cancel continues into the date/time keyboard. */
const REPLACEMENT_CANCELLED_CONTINUE_PREFIX = "Запис скасовано.";

/** True when the create draft is past service / slot / note and ready for identity. */
const bookingDetailsReady = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  return draft?.mode === "create"
    && draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot != null
    && (draft.note.status === "skipped" || draft.note.status === "answered");
};

/** Effective identity for details / restore / known-field reopen. */
const effectiveIdentityForState = (state: ClinicState) => {
  const draft = state.bookingDraft;
  const identity = resolveContactIdentity(state.contactContext, draft?.contactId);
  const open =
    state.pendingInteraction?.kind === "contact_field"
      ? state.pendingInteraction
      : null;
  return {
    identity,
    details: effectiveBookingContactDetails({
      crmContact: identity.kind === "owned" ? identity.contact : null,
      contactDetails: draft?.contactDetails ?? null,
      ...(open?.collected != null ? { collected: open.collected } : {}),
    }),
  };
};

/**
 * Occupied-phone HITL: retry linking when the candidate row is free,
 * otherwise reopen phoneNumber as occupied (never advance to names).
 */
const reopenOccupiedPhoneOrRetryLink = (
  state: ClinicState,
): { replyText: string; interaction: PendingInteraction } | null => {
  const draft = state.bookingDraft;
  if (draft == null) {
    return null;
  }
  const { identity } = effectiveIdentityForState(state);
  if (identity.kind === "phone_candidate" && phoneCandidateHasLinkableRow(identity)) {
    return {
      replyText: PATIENT_FALLBACK_MESSAGE,
      interaction: state.pendingInteraction ?? {
        kind: "contact_field",
        field: "phoneNumber",
        choices: [],
      },
    };
  }
  const session = reduceBookingSession(
    {
      bookingDraft: draft,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "contact_field_required", field: "phoneNumber", occupied: true },
  );
  if (session.pendingInteraction == null) {
    return null;
  }
  return {
    replyText: String(renderBookingInteractionMessage(session.pendingInteraction).content),
    interaction: session.pendingInteraction,
  };
};

/** Runtime-owned contact ladder once service, slot, and note are complete. */
const bookingDetailsInteraction = (
  state: ClinicState,
): { replyText: string; interaction: PendingInteraction } | null => {
  if (!bookingDetailsReady(state)) {
    return null;
  }
  const draft = state.bookingDraft!;
  const { identity, details } = effectiveIdentityForState(state);
  if (identity.kind === "phone_candidate") {
    return reopenOccupiedPhoneOrRetryLink(state);
  }
  const field = nextMissingContactField(details);
  if (field == null) {
    return null;
  }
  const session = reduceBookingSession(
    {
      bookingDraft: draft,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "contact_field_required", field },
  );
  if (session.pendingInteraction == null) {
    return null;
  }
  return {
    replyText: String(renderBookingInteractionMessage(session.pendingInteraction).content),
    interaction: session.pendingInteraction,
  };
};

const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (isModelFailureMessage(message)) {
    return "error";
  }

  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

/**
 * When the graph opens service_confirm it owns the only trailing question.
 * Drop any model-authored trailing question sentence so the patient never sees two.
 */
const stripTrailingQuestion = (text: string): string => {
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
const withServiceConfirmQuestion = (
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

export type CreateAgentFinalizeOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
  loadServices?: () => Promise<ServicesContext | null>;
};

export const createAgentFinalizeNode = (
  agent: ClinicAgentDefinition,
  options?: CreateAgentFinalizeOptions,
) =>
  async (
    state: ClinicState,
    config?: RunnableConfig,
  ): Promise<ClinicStateUpdate | Command> => {
    const agentMessages = state.agentMessages ?? [];
    if (terminalMeetingMutationOutcome(state) != null) {
      // Includes main-menu leave → Command({ goto: "supervisor" }).
      return createAgentMutationFinalizeNode(agent)(state, config);
    }
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
    };
    const chatOther = hasPendingConfirmationChatOther(state);
    const confirmationCleanup = chatOther
      ? applyMutationChatOtherCleanup(state)
      : {};
    if (chatOther) {
      clearPendingConfirmForRuntime(config);
    }

    if (!(lastMessage instanceof AIMessage)) {
      // Failed contact write: terminal this turn; preserve identity; patient-safe copy.
      if (agent.id === BOOKING_AGENT_ID) {
        const contactWrite = terminalContactWriteOutcome(state);
        if (contactWrite != null) {
          const { classification } = contactWrite;
          trackEvent("contact_write_failed", {
            tool: classification.tool,
            category: classification.category ?? classification.outcome,
          });
          const { details } = effectiveIdentityForState(state);
          let pendingInteraction = state.pendingInteraction ?? null;
          let replyText = BOOKING_CONTACT_SAVE_FAILED_UK;
          let replyButtons: string[] = [];
          if (classification.outcome === "known_field") {
            if (classification.error === CONTACT_LINK_CANDIDATE_REQUIRED_ERROR) {
              const occupied = reopenOccupiedPhoneOrRetryLink(state);
              if (occupied != null) {
                replyText = occupied.replyText;
                pendingInteraction = occupied.interaction;
                replyButtons = replyButtonsForInteraction(occupied.interaction);
              }
            } else {
              // Same ladder as details-step: never reopen a field already on CRM∪draft∪collected.
              const reopen = nextMissingContactField(details);
              if (reopen != null) {
                const session = reduceBookingSession(
                  {
                    bookingDraft: state.bookingDraft ?? null,
                    pendingInteraction,
                  },
                  { type: "contact_field_required", field: reopen },
                );
                pendingInteraction = session.pendingInteraction;
                if (pendingInteraction != null) {
                  replyText = String(
                    renderBookingInteractionMessage(pendingInteraction).content,
                  );
                  replyButtons = replyButtonsForInteraction(pendingInteraction);
                }
              } else {
                pendingInteraction = null;
              }
            }
          } else {
            // Operational: clear completed contact_field; keep contactDetails + slot.
            if (pendingInteraction?.kind === "contact_field") {
              pendingInteraction = null;
            }
          }
          return {
            ...cleared,
            ...confirmationCleanup,
            pendingInteraction,
            ...(replyText === BOOKING_PHONE_OCCUPIED_UK ? { contactContext: null } : {}),
            messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
            lastHandoff: {
              agentId: agent.id,
              agentName: agent.name,
              status: "ok",
              replyText,
              ...(replyButtons.length > 0 ? { replyButtons } : {}),
            },
          };
        }
      }
      // Graph-owned REPLACE after prepare (no LLM turn): still open the menu.
      if (
        agent.id === BOOKING_AGENT_ID
        && state.bookingDraft?.replacement?.status === "offered"
      ) {
        const meeting = state.bookingDraft.replacement.meeting;
        const visitInteraction = openVisitReplacementInteraction(meeting);
        const session = reduceBookingSession(
          {
            bookingDraft: state.bookingDraft,
            pendingInteraction: state.pendingInteraction ?? null,
          },
          { type: "visit_menu_opened", interaction: visitInteraction },
        );
        const replyText = String(renderBookingInteractionMessage(visitInteraction).content);
        const replyButtons = replyButtonsForInteraction(visitInteraction);
        return {
          ...cleared,
          ...confirmationCleanup,
          pendingInteraction: session.pendingInteraction,
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
      // Prepare/tools opened a booking-owned menu without an LLM turn (REPLACE
      // cancel continue into catalog, book-intent family chips, or «Записатись»).
      if (
        agent.id === BOOKING_AGENT_ID
        && state.pendingInteraction != null
        && isBookingOwnedInteraction(state.pendingInteraction)
        && (
          state.pendingCancellationPurpose === "replacement"
          || state.pendingInteraction.kind === "service_confirm"
          || (
            state.pendingInteraction.kind === "service_candidate"
            && state.pendingInteraction.owner === "faq"
          )
        )
      ) {
        const interaction = state.pendingInteraction;
        const isFaqCatalog =
          interaction.kind === "service_candidate"
          && interaction.owner === "faq";
        const body = isFaqCatalog
          ? renderFaqCatalogReply(
              interaction.choices,
              state.servicesContext?.list ?? [],
            )
          : String(renderBookingInteractionMessage(interaction).content);
        const replyText =
          state.pendingCancellationPurpose === "replacement"
            ? `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\n${body}`
            : body;
        const replyButtons = replyButtonsForInteraction(interaction);
        return {
          ...cleared,
          ...confirmationCleanup,
          ...(state.pendingCancellationPurpose === "replacement"
            ? { pendingCancellationPurpose: null }
            : {}),
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
      // Accepted-procedure REPLACE cancel: tools cleared pendingInteraction and
      // ran present_availability_slots. Last message is a ToolMessage — render
      // the date/time offer here so the turn does not fall through to empty.
      if (
        agent.id === BOOKING_AGENT_ID
        && state.pendingCancellationPurpose === "replacement"
        && state.bookingDraft?.mode === "create"
        && state.bookingDraft.replacement == null
        && state.bookingDraft.serviceAcceptance?.status === "accepted"
      ) {
        const offer = availabilityOfferFromToolTurn(agentMessages);
        if (offer != null) {
          const replyText =
            `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\n${offer.replyText}`;
          return {
            ...cleared,
            ...confirmationCleanup,
            pendingCancellationPurpose: null,
            pendingInteraction: offer.interaction,
            messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
            lastHandoff: {
              agentId: agent.id,
              agentName: agent.name,
              status: "ok",
              replyText,
              replyButtons: offer.replyButtons,
            },
          };
        }
        // Slots tool ran but produced no parseable offer — still continue the
        // booking (clear purpose) rather than the default menu.
        const replyText = `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\nНа жаль, зараз немає вільних слотів. Спробуйте іншу дату.`;
        return {
          ...cleared,
          ...confirmationCleanup,
          pendingCancellationPurpose: null,
          messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
          lastHandoff: {
            agentId: agent.id,
            agentName: agent.name,
            status: "ok",
            replyText,
            replyButtons: [OTHER_DATE_LABEL, MAIN_MENU_LABEL],
          },
        };
      }
      // Prepare opened FAQ catalog or a catalog offer without an LLM turn.
      if (agent.id === FAQ_AGENT_ID && state.pendingInteraction != null) {
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
      }
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(tagged.content);
    // Catalog control is the parsed tag only; every tag shape is stripped from text.
    const {
      text: textWithoutCatalogAction,
      action: faqCatalogAction,
      query: faqCatalogQuery,
    } = extractFaqCatalogAction(rawText);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(textWithoutCatalogAction);
    let replyText = text.trim();
    let replyButtons: string[] = [];
    let yieldFlag = false;
    /** "model" until a runtime rewrite owns the patient-facing text (telemetry only). */
    let replySource: "model" | "runtime" = "model";

    const detailsStep = agent.id === BOOKING_AGENT_ID ? bookingDetailsInteraction(state) : null;
    let contactFieldUpdate: ClinicStateUpdate = {};
    if (detailsStep != null) {
      // Identity collection is a deterministic graph phase. The model may call
      // contact tools, but prose cannot skip or redefine the missing-field step.
      replyText = detailsStep.replyText;
      replyButtons = replyButtonsForInteraction(detailsStep.interaction);
      replySource = "runtime";
      contactFieldUpdate = { pendingInteraction: detailsStep.interaction };
    } else if (
      agent.id === BOOKING_AGENT_ID
      && bookingDetailsReady(state)
      && state.pendingInteraction?.kind === "contact_field"
    ) {
      // Ladder finished (or owned contact is complete) — clear so create_contact can run.
      contactFieldUpdate = { pendingInteraction: null };
    }
    const clearOccupiedPhoneCandidate = detailsStep?.replyText === BOOKING_PHONE_OCCUPIED_UK
      ? { contactContext: null }
      : {};

    // Model failure: deliver via handoff only — do not persist into conversation history.
    if (status === "error" && isModelFailureMessage(tagged)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      return {
        ...cleared,
        ...confirmationCleanup,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "error",
          replyText: PATIENT_FALLBACK_MESSAGE,
          ...(agent.id === BOOKING_AGENT_ID
            ? { replyButtons: [...defaultMenuLabels(hasVisit)] }
            : {}),
        },
      };
    }

    // Already booked / committed create win over DATE/TIME rewrite when both fire same turn.
    const alreadyBooked =
      agent.id === BOOKING_AGENT_ID && createMeetingAlreadyBooked(agentMessages);
    const replacementOffered =
      agent.id === BOOKING_AGENT_ID
      && state.bookingDraft?.replacement?.status === "offered";
    const createCommitted =
      agent.id === BOOKING_AGENT_ID
      && agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && message.name === "create_meeting"
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
    const mutationCommitted =
      createCommitted
      || agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && (message.name === "cancel_meeting" || message.name === "reschedule_meeting")
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
    const createError = latestCreateMeetingError(agentMessages);
    const noteBlockedThisTurn = createError === CREATE_NOTE_REQUIRED_ERROR;
    const awaitingNote =
      agent.id === BOOKING_AGENT_ID
      && (authoritativeNoteStatus(state) === "awaiting" || noteBlockedThisTurn)
      && authoritativeSelectedSlot(state) != null
      && !alreadyBooked;
    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer =
      agent.id === BOOKING_AGENT_ID
      && !alreadyBooked
      && !createCommitted
      && bookingDraftCanPresentAvailability(state.bookingDraft)
        ? resolveAvailabilityOffer(
            agentMessages,
            state.availabilityContext,
            authoritativeSelectedSlot(state) == null,
          )
          ?? (noteBlockedThisTurn && authoritativeSelectedSlot(state) == null
            ? availabilityRecoveryOffer(state)
            : null)
        : null;
    const requestedTimeUnavailable =
      agent.id === BOOKING_AGENT_ID
      && state.bookingDraft?.requestedTime?.status === "unavailable"
      && state.bookingDraft.selectedDate != null;
    const unavailableDate = state.bookingDraft?.selectedDate;
    const unavailableTime = state.bookingDraft?.requestedTime?.value;
    let clearServiceChangeNotice = false;
    const consumeServiceChangeNotice = (): string | null => {
      const notice = state.serviceChangeNotice;
      if (notice == null || notice.length === 0) {
        return null;
      }
      clearServiceChangeNotice = true;
      return notice;
    };
    let availabilityInteraction: DateSelectInteraction | TimeSelectInteraction | null =
      slotOffer?.interaction ?? null;
    let serviceOfferUpdate: ClinicStateUpdate = {};

    let visitSelectUpdate: ClinicStateUpdate = {};
    if (replacementOffered) {
      const meeting = state.bookingDraft?.replacement?.meeting;
      if (meeting != null) {
        const visitInteraction = openVisitReplacementInteraction(meeting);
        const session = reduceBookingSession(
          {
            bookingDraft: state.bookingDraft ?? null,
            pendingInteraction: state.pendingInteraction ?? null,
          },
          { type: "visit_menu_opened", interaction: visitInteraction },
        );
        visitSelectUpdate = { pendingInteraction: session.pendingInteraction };
        replyText = String(renderBookingInteractionMessage(visitInteraction).content);
        replyButtons = replyButtonsForInteraction(visitInteraction);
        replySource = "runtime";
      } else {
        replyButtons = [...BOOKING_REPLACE_MENU];
      }
    } else if (slotOffer) {
      const unavailablePrefix = requestedTimeUnavailable
        ? `На жаль, о ${unavailableTime} на ${formatKyivDayLabel(unavailableDate!, kyivToday())} немає вільного часу.\n\n`
        : "";
      const offerBody = unavailablePrefix
        + (
          createError != null && !noteBlockedThisTurn
            ? `${SLOT_JUST_TAKEN_PREFIX}${slotOffer.replyText}`
            : slotOffer.replyText
        );
      const notice = consumeServiceChangeNotice();
      replyText = notice != null ? `${notice}\n\n${offerBody}` : offerBody;
      replyButtons = slotOffer.replyButtons;
      availabilityInteraction = slotOffer.interaction;
      replySource = "runtime";
    } else if (
      agent.id === BOOKING_AGENT_ID
      && state.pendingInteraction != null
      && isBookingOwnedInteraction(state.pendingInteraction)
      && (state.pendingInteraction.kind === "service_or_note"
        || state.pendingInteraction.kind === "service_candidate"
        || state.pendingInteraction.kind === "visit_note"
        || state.pendingInteraction.kind === "service_confirm"
        || state.pendingInteraction.kind === "date_select"
        || state.pendingInteraction.kind === "time_select"
        || state.pendingInteraction.kind === "catalog_detour")
      && !slotOffer
      && !alreadyBooked
    ) {
      const rendered = renderBookingInteractionMessage(state.pendingInteraction);
      replyText = String(rendered.content);
      replyButtons = replyButtonsForInteraction(state.pendingInteraction);
      replySource = "runtime";
      trackEvent("reply_menu_filled", {
        menu: state.pendingInteraction.kind,
        reason: "pending_interaction",
      });
    } else if (awaitingNote) {
      const noteInteraction =
        state.pendingInteraction?.kind === "visit_note"
          ? state.pendingInteraction
          : openVisitNoteInteraction();
      const rendered = renderBookingInteractionMessage(noteInteraction);
      replyText = String(rendered.content);
      replyButtons = replyButtonsForInteraction(noteInteraction);
      replySource = "runtime";
      if (state.pendingInteraction?.kind !== "visit_note") {
        serviceOfferUpdate = {
          ...serviceOfferUpdate,
          pendingInteraction: noteInteraction,
        };
      }
      trackEvent("reply_menu_filled", { menu: "visit_note", reason: "pending_interaction" });
    } else if (alreadyBooked) {
      const conflict = alreadyBookedMeetingFromMessages(agentMessages);
      const visitLabel = conflict?.name != null && conflict.dateStart != null
        ? `${meetingServiceLabel(conflict.name)} - ${formatKyivDateTimeLabel(conflict.dateStart, kyivToday())}`
        : undefined;
      replyText = alreadyBookedReplaceReplyUk(visitLabel);
      replyButtons = [...BOOKING_REPLACE_MENU];
      replySource = "runtime";
      trackEvent("reply_menu_filled", { menu: "replace", reason: "already_booked" });
    } else if (agent.id === FAQ_AGENT_ID) {
      const openFaqCatalog =
        state.pendingInteraction?.kind === "service_candidate"
        && state.pendingInteraction.owner === "faq";
      const openCatalogDetour = state.pendingInteraction?.kind === "catalog_detour";
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
          serviceOfferUpdate = {
            ...servicesUpdate,
            bookingDraft: session.bookingDraft,
            pendingInteraction: session.pendingInteraction,
          };
          if (session.pendingInteraction.kind === "service_candidate") {
            const modelIntro = faqCatalogIntroFromModel(replyText);
            replyText = renderFaqCatalogReply(
              session.pendingInteraction.choices,
              services,
              modelIntro,
            );
            replyButtons = replyButtonsForInteraction(session.pendingInteraction);
            replySource = "runtime";
            trackEvent("reply_menu_filled", {
              menu: "service_candidate",
              reason: "faq_open_catalog",
            });
          } else if (session.pendingInteraction.kind === "service_confirm") {
            replyText = withServiceConfirmQuestion(
              replyText,
              session.pendingInteraction,
            );
            replyButtons = replyButtonsForInteraction(session.pendingInteraction);
            replySource = "runtime";
            yieldFlag = true;
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
              serviceOfferUpdate = {
                bookingDraft: session.bookingDraft,
                pendingInteraction: session.pendingInteraction,
              };
              if (session.pendingInteraction?.kind === "service_confirm") {
                replyText = withServiceConfirmQuestion(
                  replyText,
                  session.pendingInteraction,
                );
                replyButtons = replyButtonsForInteraction(
                  session.pendingInteraction,
                );
                yieldFlag = true;
                trackEvent("reply_menu_filled", {
                  menu: "service_confirm",
                  reason: "faq_catalog_declined_singleton",
                });
              }
            } else {
              const modelIntro = faqCatalogIntroFromModel(replyText);
              replyText = renderFaqCatalogReply(
                catalog.choices,
                state.servicesContext?.list ?? [],
                modelIntro,
              );
              replyButtons = replyButtonsForInteraction(catalog);
              // Keep the open catalog explicitly so the decline flag survives.
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
              replyText = withServiceConfirmQuestion(replyText, session.pendingInteraction);
              replyButtons = replyButtonsForInteraction(session.pendingInteraction);
              yieldFlag = true;
              trackEvent("reply_menu_filled", {
                menu: "service_confirm",
                reason: "faq_catalog_action",
              });
            }
          }
        } else if (faqCatalogAction === "close_catalog") {
          serviceOfferUpdate = { pendingInteraction: null };
          // Keep model prose; drop catalog chips.
          replyButtons = [];
          trackEvent("reply_menu_filled", {
            menu: "service_candidate",
            reason: "faq_catalog_close",
          });
        } else {
          // keep_catalog may keep a short clarification; missing/invalid drop
          // model prose so stale choose_other copy cannot diverge from chips.
          const modelIntro = faqCatalogAction === "keep_catalog"
            ? faqCatalogIntroFromModel(replyText)
            : "";
          replyText = renderFaqCatalogReply(
            catalog.choices,
            state.servicesContext?.list ?? [],
            modelIntro,
          );
          replyButtons = replyButtonsForInteraction(catalog);
          trackEvent("reply_menu_filled", {
            menu: "service_candidate",
            reason: "pending_interaction",
          });
        }
      } else if (openCatalogDetour) {
        replyText = String(
          renderBookingInteractionMessage(state.pendingInteraction!).content,
        );
        replyButtons = replyButtonsForInteraction(state.pendingInteraction!);
        trackEvent("reply_menu_filled", {
          menu: state.pendingInteraction!.kind,
          reason: "pending_interaction",
        });
      } else {
        // Accidental trailers / bullets never become FAQ chips — only reducer-
        // opened catalog interactions own replyButtons.
        replyButtons = [];
        const returnLabel = state.pendingInteraction?.choices.find(
          (choice) => choice.id === "return_to_booking",
        )?.label;
        if (returnLabel != null && returnLabel.length > 0) {
          replyButtons = [returnLabel];
        }
      }
    } else if (
      agent.id === BOOKING_AGENT_ID
      && replyText.length > 0
      && detailsStep == null
    ) {
      // DDD-54: DEFAULT MENU only on idle mutation turns — not phone/name mid-flow.
      // When detailsStep owns the handoff, do not reattach leftover mutation_confirm ✅/❌.
      const idle = agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && (classifyMeetingMutationToolMessage(message) === "committed"
            || meetingMutationIsHitlDecline(message)),
      );
      const cancelChatOther = chatOther
        && agentMessages.some(
          (message) =>
            message instanceof ToolMessage
            && message.name === "cancel_meeting"
            && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
        );
      if (idle) {
        replyButtons = [
          ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
        ];
        trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
      } else if (cancelChatOther) {
        // Prefer ✅/❌ over a stale visit menu when cancel HITL chat-other
        // reaches finalize instead of command_prepare re-arm.
        replyButtons = [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL];
        trackEvent("reply_menu_filled", { menu: "mutation_confirm", reason: "cancel_chat_other" });
      } else if (
        state.pendingInteraction != null
        && isBookingOwnedInteraction(state.pendingInteraction)
      ) {
        replyButtons = replyButtonsForInteraction(state.pendingInteraction);
      } else {
        replyButtons = [];
      }
    }

    // Fail closed: in any booking-outcome risk state (non-committed write,
    // details/confirming, open ✅/❌), model prose never ships. Runtime owns
    // the next step. DATE/TIME/SERVICE without a slot card are included.
    const outcomeRisk =
      agent.id === BOOKING_AGENT_ID
      && !createCommitted
      && bookingOutcomeRiskState(state);
    const scheduleReselectPending =
      agent.id === BOOKING_AGENT_ID
      && !createCommitted
      && !alreadyBooked
      && !slotOffer
      && !replacementOffered
      && !isBookingOwnedInteraction(state.pendingInteraction)
      && state.bookingDraft != null
      && (
        state.bookingDraft.phase === "date"
        || state.bookingDraft.phase === "time"
        || state.bookingDraft.phase === "service"
      );
    if (
      (outcomeRisk || scheduleReselectPending)
      && replySource !== "runtime"
      && !alreadyBooked
      && !replacementOffered
      && !slotOffer
      && detailsStep == null
    ) {
      const pendingConfirmation = agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
      ) || state.pendingInteraction?.kind === "mutation_confirm";
      if (pendingConfirmation) {
        // Open ✅/❌ outranks a stale visit/DATE menu left from before HITL.
        replyText = BOOKING_AWAITING_CONFIRM_UK;
        replyButtons = [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL];
        replySource = "runtime";
        trackEvent("reply_menu_filled", {
          menu: "mutation_confirm",
          reason: "outcome_risk",
        });
      } else if (
        state.pendingInteraction != null
        && isBookingOwnedInteraction(state.pendingInteraction)
      ) {
        replyText = String(
          renderBookingInteractionMessage(state.pendingInteraction).content,
        );
        replyButtons = replyButtonsForInteraction(state.pendingInteraction);
        replySource = "runtime";
        trackEvent("reply_menu_filled", {
          menu: state.pendingInteraction.kind,
          reason: "outcome_risk",
        });
      } else {
        const recovered = availabilityRecoveryOffer(state);
        if (recovered != null) {
          const notice = consumeServiceChangeNotice();
          const body = createError != null && !noteBlockedThisTurn
            ? `${SLOT_JUST_TAKEN_PREFIX}${recovered.replyText}`
            : recovered.replyText;
          replyText = notice != null ? `${notice}\n\n${body}` : body;
          replyButtons = recovered.replyButtons;
          availabilityInteraction = recovered.interaction;
          replySource = "runtime";
        } else if (scheduleReselectPending) {
          replyText = consumeServiceChangeNotice() ?? BOOKING_SCHEDULE_RESELECT_UK;
          replyButtons = [];
          replySource = "runtime";
        } else {
          // Uncommitted ready / details with no card — DEFAULT MENU, not error fallback.
          replyText = consumeServiceChangeNotice() ?? MAIN_MENU_GREETING_UK;
          replyButtons = replyButtons.length > 0
            ? replyButtons
            : [...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext))];
          replySource = "runtime";
          trackEvent("reply_menu_filled", { menu: "default", reason: "outcome_risk" });
        }
      }
    }

    // Never ship model claimsOutcome unless this turn committed a meeting mutation.
    if (
      replySource === "model"
      && (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID)
      && !mutationCommitted
    ) {
      const claim = claimsOutcome(replyText);
      if (claim != null) {
        trackEvent("false_success_claim", {
          rule: claim.rule,
          phase: state.bookingDraft?.phase ?? null,
          agent: agent.id,
        });
        if (
          agent.id === BOOKING_AGENT_ID
          && state.pendingInteraction != null
          && isBookingOwnedInteraction(state.pendingInteraction)
        ) {
          replyText = String(
            renderBookingInteractionMessage(state.pendingInteraction).content,
          );
          replyButtons = replyButtonsForInteraction(state.pendingInteraction);
          replySource = "runtime";
        } else {
          replyText = MAIN_MENU_GREETING_UK;
          replyButtons = [
            ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
          ];
          replySource = "runtime";
          trackEvent("reply_menu_filled", {
            menu: "default",
            reason: "false_success_claim",
          });
        }
      }
    }

    if (yieldTag && agent.id === FAQ_AGENT_ID) {
      yieldFlag = true;
    }

    const noteStatusForHandoff: ClinicStateUpdate =
      awaitingNote
      && !slotOffer
      && state.bookingDraft != null
      && state.bookingDraft.note.status !== "awaiting"
      && state.pendingInteraction == null
        ? {
            bookingDraft: reduceBookingDraft(state.bookingDraft, {
              type: "note_status",
              status: "awaiting",
            }),
          }
        : {};

    // Open service_confirm from structured service identity (not offer-question prose).
    if (
      !alreadyBooked
      && !slotOffer
      && availabilityInteraction == null
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
        serviceOfferUpdate = {
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
            replyText = withServiceConfirmQuestion(replyText, session.pendingInteraction);
          } else if (replyText.length === 0) {
            replyText = String(
              renderBookingInteractionMessage(session.pendingInteraction).content,
            );
          }
          if (detailsStep == null) {
            replyButtons = replyButtonsForInteraction(session.pendingInteraction);
          }
          if (agent.id === FAQ_AGENT_ID) {
            yieldFlag = true;
          }
          trackEvent("reply_menu_filled", { menu: "service_confirm", reason: "pending_interaction" });
        }
      }
    } else if (
      state.pendingInteraction?.kind === "service_confirm"
      && detailsStep == null
      && !alreadyBooked
      && !slotOffer
      && replyButtons.length === 0
    ) {
      // Offer keyboard still open (price/comparison follow-up, unmatched
      // text). Catalog resume happens in prepare: it opens service_candidate
      // before the LLM, and keep_catalog then attaches those chips above.
      if (replyText.length === 0) {
        replyText = String(renderBookingInteractionMessage(state.pendingInteraction).content);
      }
      replyButtons = replyButtonsForInteraction(state.pendingInteraction);
      if (agent.id === FAQ_AGENT_ID) {
        yieldFlag = true;
      }
      trackEvent("reply_menu_filled", { menu: "service_confirm", reason: "pending_interaction" });
    }

    const availabilityPresented = availabilityInteraction != null
      ? reduceBookingSession(
          {
            bookingDraft: state.bookingDraft ?? null,
            pendingInteraction: state.pendingInteraction ?? null,
          },
          { type: "availability_presented", interaction: availabilityInteraction },
        )
      : null;
    const availabilityInteractionUpdate: ClinicStateUpdate =
      availabilityPresented != null
        ? {
            pendingInteraction: availabilityPresented.pendingInteraction,
            ...(availabilityPresented.clearAvailability
              ? { availabilityContext: null, availabilityCursor: null }
              : {}),
          }
        : {};
    const bookingDraftOfferUpdate = serviceOfferUpdate;
    const blockedConfirmationMutation =
      hasMutationCallDuringUnresolvedConfirmation(state);

    const replyMessage =
      replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || slotOffer != null
        || blockedConfirmationMutation
        ? new AIMessage({
            content: replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(replyText.length > 0 ? { replyText } : {}),
      ...(replyButtons.length > 0 ? { replyButtons } : {}),
      ...(yieldFlag ? { yieldToSupervisor: true } : {}),
    };
    const serviceChangeNoticeClear: { serviceChangeNotice?: null } =
      clearServiceChangeNotice ? { serviceChangeNotice: null } : {};
    // One-turn named_procedure gate — consume after FAQ (or any) finalize.
    const supervisorIntentClear: { supervisorIntent: null } = { supervisorIntent: null };

    if (status === "empty") {
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        ...bookingDraftOfferUpdate,
        ...availabilityInteractionUpdate,
        ...visitSelectUpdate,
        ...contactFieldUpdate,
        ...confirmationCleanup,
        ...clearOccupiedPhoneCandidate,
        ...serviceChangeNoticeClear,
        ...supervisorIntentClear,
      };
    }

    if (status === "max_steps") {
      if (replyText.length === 0) {
        console.error(
          `[clinic-${agent.id}] exceeded the maximum of ${agent.maxSteps} tool steps.`,
        );
      }
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        ...bookingDraftOfferUpdate,
        ...availabilityInteractionUpdate,
        ...visitSelectUpdate,
        ...contactFieldUpdate,
        ...confirmationCleanup,
        ...clearOccupiedPhoneCandidate,
        ...serviceChangeNoticeClear,
        ...supervisorIntentClear,
        messages: [
          replyText.length > 0
            ? replyMessage
            : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
      ...noteStatusForHandoff,
      ...bookingDraftOfferUpdate,
      ...availabilityInteractionUpdate,
      ...visitSelectUpdate,
      ...contactFieldUpdate,
      ...confirmationCleanup,
      ...clearOccupiedPhoneCandidate,
      ...serviceChangeNoticeClear,
      ...supervisorIntentClear,
      messages: [replyMessage],
    };
  };

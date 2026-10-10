import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Overwrite } from "@langchain/langgraph";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
  type ClinicHandoffStatus,
} from "../types.js";
import { formatKyivDayLabel, kyivToday } from "../../tools/availability-slots.js";
import { contactMissingFields } from "../../tools/contact-tools.js";
import { trackEvent } from "../../analytics/track.js";
import {
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_REPLACE_MENU,
  BOOKING_SCHEDULE_RESELECT_UK,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractReplyButtons,
  matchesReplyLabel,
} from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { clearPendingConfirmForRuntime } from "../../tools/meeting-confirm.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { reduceBookingDraft } from "../booking-draft.js";
import {
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
  FAQ_SERVICES_GUIDE_LABELS,
  SLOT_JUST_TAKEN_PREFIX,
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  availabilityRecoveryOffer,
  classifyMeetingMutationToolMessage,
  consultationService,
  createMeetingAlreadyBooked,
  lastPatientText,
  latestCreateMeetingError,
  meetingMutationIsHitlDecline,
  offeredServiceForTurn,
  phoneCandidateHasLinkableRow,
  resolveAvailabilityOffer,
  resolveContactIdentity,
  terminalMeetingMutationOutcome,
} from "./shared.js";

/** True when the create draft is past service / slot / note and ready for identity. */
const bookingDetailsReady = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  return draft?.mode === "create"
    && draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot != null
    && (draft.note.status === "skipped" || draft.note.status === "answered");
};

/** Runtime-owned contact ladder once service, slot, and note are complete. */
const bookingDetailsInteraction = (
  state: ClinicState,
): { replyText: string; interaction: PendingInteraction } | null => {
  if (!bookingDetailsReady(state)) {
    return null;
  }
  const draft = state.bookingDraft!;
  const identity = resolveContactIdentity(state.contactContext, draft.contactId);
  let field: "phoneNumber" | "firstName" | "lastName" | null = null;
  let occupied = false;
  if (identity.kind === "unresolved") {
    const open =
      state.pendingInteraction?.kind === "contact_field"
        ? state.pendingInteraction
        : null;
    const collected = open?.collected;
    const latest = lastPatientText(state);
    const latestPhone = normalizeClinicPhone(latest);
    if (open?.field === "firstName") {
      // Prepare stores accepted names on collected; asides leave the field open.
      field = collected?.firstName ? "lastName" : "firstName";
    } else if (open?.field === "lastName") {
      if (collected?.lastName) {
        // All three values are ready — release the field for create_contact.
        return null;
      }
      field = "lastName";
    } else if (latestPhone != null) {
      field = "firstName";
    } else {
      field = "phoneNumber";
    }
  } else if (identity.kind === "phone_candidate") {
    if (phoneCandidateHasLinkableRow(identity)) {
      return {
        replyText: PATIENT_FALLBACK_MESSAGE,
        interaction: state.pendingInteraction ?? {
          kind: "contact_field",
          field: "phoneNumber",
          choices: [],
        },
      };
    }
    field = "phoneNumber";
    occupied = true;
  } else {
    const missingField = contactMissingFields(identity.contact)[0];
    if (missingField === "firstName" || missingField === "lastName" || missingField === "phoneNumber") {
      field = missingField;
    }
  }
  if (field == null) {
    return null;
  }
  const session = reduceBookingSession(
    {
      bookingDraft: draft,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "contact_field_required", field, occupied },
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

export const createAgentFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState, config?: RunnableConfig): ClinicStateUpdate => {
    const agentMessages = state.agentMessages ?? [];
    if (terminalMeetingMutationOutcome(state) != null) {
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
    const { text: textWithoutCatalogAction, action: faqCatalogAction } =
      extractFaqCatalogAction(rawText);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(textWithoutCatalogAction);
    let replyText = text.trim();
    let replyButtons: string[] = [];
    let yieldFlag = false;

    const detailsStep = agent.id === BOOKING_AGENT_ID ? bookingDetailsInteraction(state) : null;
    let contactFieldUpdate: ClinicStateUpdate = {};
    if (detailsStep != null) {
      // Identity collection is a deterministic graph phase. The model may call
      // contact tools, but prose cannot skip or redefine the missing-field step.
      replyText = detailsStep.replyText;
      replyButtons = replyButtonsForInteraction(detailsStep.interaction);
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
    const createError = latestCreateMeetingError(agentMessages);
    const noteBlockedThisTurn = createError === CREATE_NOTE_REQUIRED_ERROR;
    const awaitingNote =
      agent.id === BOOKING_AGENT_ID
      && (authoritativeNoteStatus(state) === "awaiting" || noteBlockedThisTurn)
      && authoritativeSelectedSlot(state) != null
      && !alreadyBooked;
    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer =
      agent.id === BOOKING_AGENT_ID && !alreadyBooked && !createCommitted
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
      if (state.pendingInteraction?.kind !== "visit_note") {
        serviceOfferUpdate = {
          ...serviceOfferUpdate,
          pendingInteraction: noteInteraction,
        };
      }
      trackEvent("reply_menu_filled", { menu: "visit_note", reason: "pending_interaction" });
    } else if (alreadyBooked) {
      replyButtons = [...BOOKING_REPLACE_MENU];
    } else if (agent.id === FAQ_AGENT_ID) {
      const openFaqCatalog =
        state.pendingInteraction?.kind === "service_candidate"
        && state.pendingInteraction.owner === "faq";
      const openCatalogDetour = state.pendingInteraction?.kind === "catalog_detour";
      if (openFaqCatalog) {
        const catalog = state.pendingInteraction as PendingInteraction & {
          kind: "service_candidate";
          owner: "faq";
        };
        if (faqCatalogAction === "offer_consultation") {
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
    } else if (agent.id === BOOKING_AGENT_ID && replyText.length > 0) {
      // DDD-54: DEFAULT MENU only on idle mutation turns — not phone/name mid-flow.
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

    // Fail closed: DATE/TIME/SERVICE without a code-owned slot card or committed
    // write never ships model prose (any language). Runtime owns the next step.
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
    if (scheduleReselectPending) {
      const recovered = availabilityRecoveryOffer(state);
      if (recovered != null) {
        const notice = consumeServiceChangeNotice();
        replyText = notice != null
          ? `${notice}\n\n${recovered.replyText}`
          : recovered.replyText;
        replyButtons = recovered.replyButtons;
        availabilityInteraction = recovered.interaction;
      } else {
        replyText = consumeServiceChangeNotice() ?? BOOKING_SCHEDULE_RESELECT_UK;
        replyButtons = [];
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
          const servicesGuide = matchesReplyLabel(
            lastPatientText(state),
            FAQ_SERVICES_GUIDE_LABELS,
          );
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
          replyButtons = replyButtonsForInteraction(session.pendingInteraction);
          if (agent.id === FAQ_AGENT_ID) {
            yieldFlag = true;
          }
          trackEvent("reply_menu_filled", { menu: "service_confirm", reason: "pending_interaction" });
        }
      }
    } else if (
      state.pendingInteraction?.kind === "service_confirm"
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

    const availabilityInteractionUpdate: ClinicStateUpdate =
      availabilityInteraction != null
        ? {
            pendingInteraction: reduceBookingSession(
              {
                bookingDraft: state.bookingDraft ?? null,
                pendingInteraction: state.pendingInteraction ?? null,
              },
              { type: "availability_presented", interaction: availabilityInteraction },
            ).pendingInteraction,
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
      messages: [replyMessage],
    };
  };

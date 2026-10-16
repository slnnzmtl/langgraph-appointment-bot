import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../../types.js";
import {
  formatKyivDayLabel,
  kyivToday,
} from "../../../tools/availability-slots.js";
import { trackEvent } from "../../../analytics/track.js";
import {
  BOOKING_AWAITING_CONFIRM_UK,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_REPLACE_MENU,
  BOOKING_SCHEDULE_RESELECT_UK,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  MAIN_MENU_GREETING_UK,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  alreadyBookedReplaceReplyUk,
  defaultMenuLabels,
} from "../../../shared/clinic-constants.js";
import { claimsOutcome } from "../../../shared/outcome-claims.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  bookingDraftCanPresentAvailability,
  reduceBookingDraft,
} from "../../booking-draft.js";
import { visitLabelForMeetingStart } from "../../../tools/visit-label.js";
import {
  isBookingOwnedInteraction,
  openVisitNoteInteraction,
  openVisitReplacementInteraction,
  reduceBookingSession,
  type DateSelectInteraction,
  type PendingInteraction,
  type TimeSelectInteraction,
} from "../../booking-session.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
  SLOT_JUST_TAKEN_PREFIX,
  availabilityOfferFromToolTurn,
  availabilityRecoveryOffer,
  resolveAvailabilityOffer,
} from "../../booking-interaction-render.js";
import {
  renderFaqCatalogReply,
} from "../../faq-catalog.js";
import { tagRuntimeAgentMessage } from "../../sub-agent-messages.js";
import {
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  bookingOutcomeRiskState,
} from "../booking-command.js";
import { defaultMenuHasVisit } from "../mutation-finalize.js";
import {
  alreadyBookedMeetingFromMessages,
  classifyMeetingMutationToolMessage,
  createMeetingAlreadyBooked,
  latestCreateMeetingError,
  meetingMutationIsHitlDecline,
} from "../protocol.js";
import {
  bookingDetailsInteraction,
  bookingDetailsReady,
} from "./contact.js";
import type { ClearedTape } from "./shared.js";

/** Prefix when REPLACE cancel continues into the date/time keyboard. */
const REPLACEMENT_CANCELLED_CONTINUE_PREFIX = "Запис скасовано.";

/**
 * Non-AI booking paths: REPLACE menus, booking-owned prepare/tools UIs,
 * REPLACE-cancel availability offer.
 */
export const finalizeNonAiBooking = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  cleared: ClearedTape,
  confirmationCleanup: ClinicStateUpdate,
): ClinicStateUpdate | null => {
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
  return null;
};

export type BookingAiReplyBag = {
  replyText: string;
  replyButtons: string[];
  replySource: "model" | "runtime";
  yieldFlag: boolean;
  availabilityInteraction: DateSelectInteraction | TimeSelectInteraction | null;
  serviceOfferUpdate: ClinicStateUpdate;
  visitSelectUpdate: ClinicStateUpdate;
  clearServiceChangeNotice: boolean;
  detailsStep: { replyText: string; interaction: PendingInteraction } | null;
  contactFieldUpdate: ClinicStateUpdate;
  clearOccupiedPhoneCandidate: ClinicStateUpdate;
  chatOther: boolean;
  alreadyBooked: boolean;
  replacementOffered: boolean;
  createCommitted: boolean;
  mutationCommitted: boolean;
  createError: string | undefined;
  awaitingNote: boolean;
  slotOffer: ReturnType<typeof resolveAvailabilityOffer>;
  requestedTimeUnavailable: boolean;
  unavailableDate: string | null | undefined;
  unavailableTime: string | null | undefined;
};

const consumeServiceChangeNotice = (
  state: ClinicState,
  bag: BookingAiReplyBag,
): string | null => {
  const notice = state.serviceChangeNotice;
  if (notice == null || notice.length === 0) {
    return null;
  }
  bag.clearServiceChangeNotice = true;
  return notice;
};

/** Compute booking AI prelude flags and contact details step. */
export const initBookingAiReplyBag = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  replyText: string,
  chatOther: boolean,
): BookingAiReplyBag => {
  const detailsStep = agent.id === BOOKING_AGENT_ID ? bookingDetailsInteraction(state) : null;
  let contactFieldUpdate: ClinicStateUpdate = {};
  let shapedReplyText = replyText;
  let replyButtons: string[] = [];
  let replySource: "model" | "runtime" = "model";
  if (detailsStep != null) {
    // Identity collection is a deterministic graph phase. The model may call
    // contact tools, but prose cannot skip or redefine the missing-field step.
    shapedReplyText = detailsStep.replyText;
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
  const awaitingNote =
    agent.id === BOOKING_AGENT_ID
    && authoritativeNoteStatus(state) === "awaiting"
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
      : null;
  const requestedTimeUnavailable =
    agent.id === BOOKING_AGENT_ID
    && state.bookingDraft?.requestedTime?.status === "unavailable"
    && state.bookingDraft.selectedDate != null;
  const unavailableDate = state.bookingDraft?.selectedDate;
  const unavailableTime = state.bookingDraft?.requestedTime?.value;

  return {
    replyText: shapedReplyText,
    replyButtons,
    replySource,
    yieldFlag: false,
    availabilityInteraction: slotOffer?.interaction ?? null,
    serviceOfferUpdate: {},
    visitSelectUpdate: {},
    clearServiceChangeNotice: false,
    detailsStep,
    contactFieldUpdate,
    clearOccupiedPhoneCandidate,
    chatOther,
    alreadyBooked,
    replacementOffered,
    createCommitted,
    mutationCommitted,
    createError,
    awaitingNote,
    slotOffer,
    requestedTimeUnavailable,
    unavailableDate,
    unavailableTime,
  };
};

/**
 * REPLACE / slot / visit-note / already-booked / pending-interaction /
 * default-menu present paths for the booking AI branch.
 * Returns which branch fired so index can dispatch FAQ next.
 */
export type BookingPresentBranch =
  | "replacement"
  | "slot"
  | "pending_owned"
  | "awaiting_note"
  | "already_booked"
  | "default_menu"
  | "none";

export const applyBookingPresentPaths = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  bag: BookingAiReplyBag,
): BookingPresentBranch => {
  if (bag.replacementOffered) {
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
      bag.visitSelectUpdate = { pendingInteraction: session.pendingInteraction };
      bag.replyText = String(renderBookingInteractionMessage(visitInteraction).content);
      bag.replyButtons = replyButtonsForInteraction(visitInteraction);
      bag.replySource = "runtime";
    } else {
      bag.replyButtons = [...BOOKING_REPLACE_MENU];
    }
    return "replacement";
  }
  if (bag.slotOffer) {
    const unavailablePrefix = bag.requestedTimeUnavailable
      ? `На жаль, о ${bag.unavailableTime} на ${formatKyivDayLabel(bag.unavailableDate!, kyivToday())} немає вільного часу.\n\n`
      : "";
    const offerBody = unavailablePrefix
      + (
        bag.createError != null
          ? `${SLOT_JUST_TAKEN_PREFIX}${bag.slotOffer.replyText}`
          : bag.slotOffer.replyText
      );
    const notice = consumeServiceChangeNotice(state, bag);
    bag.replyText = notice != null ? `${notice}\n\n${offerBody}` : offerBody;
    bag.replyButtons = bag.slotOffer.replyButtons;
    bag.availabilityInteraction = bag.slotOffer.interaction;
    bag.replySource = "runtime";
    return "slot";
  }
  if (
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
    && !bag.slotOffer
    && !bag.alreadyBooked
  ) {
    const rendered = renderBookingInteractionMessage(state.pendingInteraction);
    bag.replyText = String(rendered.content);
    bag.replyButtons = replyButtonsForInteraction(state.pendingInteraction);
    bag.replySource = "runtime";
    trackEvent("reply_menu_filled", {
      menu: state.pendingInteraction.kind,
      reason: "pending_interaction",
    });
    return "pending_owned";
  }
  if (bag.awaitingNote) {
    const noteInteraction =
      state.pendingInteraction?.kind === "visit_note"
        ? state.pendingInteraction
        : openVisitNoteInteraction();
    const rendered = renderBookingInteractionMessage(noteInteraction);
    bag.replyText = String(rendered.content);
    bag.replyButtons = replyButtonsForInteraction(noteInteraction);
    bag.replySource = "runtime";
    if (state.pendingInteraction?.kind !== "visit_note") {
      bag.serviceOfferUpdate = {
        ...bag.serviceOfferUpdate,
        pendingInteraction: noteInteraction,
      };
    }
    trackEvent("reply_menu_filled", { menu: "visit_note", reason: "pending_interaction" });
    return "awaiting_note";
  }
  if (bag.alreadyBooked) {
    const conflict = alreadyBookedMeetingFromMessages(agentMessages);
    const visitLabel = conflict?.name != null && conflict.dateStart != null
      ? visitLabelForMeetingStart(conflict.name, conflict.dateStart)
      : undefined;
    bag.replyText = alreadyBookedReplaceReplyUk(visitLabel);
    bag.replyButtons = [...BOOKING_REPLACE_MENU];
    bag.replySource = "runtime";
    trackEvent("reply_menu_filled", { menu: "replace", reason: "already_booked" });
    return "already_booked";
  }
  return "none";
};

/** Default-menu / cancel-chat-other button fill when booking AI has model prose. */
export const applyBookingDefaultMenuButtons = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  bag: BookingAiReplyBag,
): void => {
  if (
    agent.id !== BOOKING_AGENT_ID
    || bag.replyText.length === 0
    || bag.detailsStep != null
  ) {
    return;
  }
  // DDD-54: DEFAULT MENU only on idle mutation turns — not phone/name mid-flow.
  // When detailsStep owns the handoff, do not reattach leftover mutation_confirm ✅/❌.
  const idle = agentMessages.some(
    (message) =>
      message instanceof ToolMessage
      && (classifyMeetingMutationToolMessage(message) === "committed"
        || meetingMutationIsHitlDecline(message)),
  );
  const cancelChatOther = bag.chatOther
    && agentMessages.some(
      (message) =>
        message instanceof ToolMessage
        && message.name === "cancel_meeting"
        && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
    );
  if (idle) {
    bag.replyButtons = [
      ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
    ];
    trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
  } else if (cancelChatOther) {
    // Prefer ✅/❌ over a stale visit menu when cancel HITL chat-other
    // reaches finalize instead of command_prepare re-arm.
    bag.replyButtons = [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL];
    trackEvent("reply_menu_filled", { menu: "mutation_confirm", reason: "cancel_chat_other" });
  } else if (
    state.pendingInteraction != null
    && isBookingOwnedInteraction(state.pendingInteraction)
  ) {
    bag.replyButtons = replyButtonsForInteraction(state.pendingInteraction);
  } else {
    bag.replyButtons = [];
  }
};

/** Outcome-risk / schedule-reselect fail-closed rewrite. */
export const applyBookingOutcomeRisk = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  bag: BookingAiReplyBag,
): void => {
  // Fail closed: in any booking-outcome risk state (non-committed write,
  // details/confirming, open ✅/❌), model prose never ships. Runtime owns
  // the next step. DATE/TIME/SERVICE without a slot card are included.
  const outcomeRisk =
    agent.id === BOOKING_AGENT_ID
    && !bag.createCommitted
    && bookingOutcomeRiskState(state);
  const scheduleReselectPending =
    agent.id === BOOKING_AGENT_ID
    && !bag.createCommitted
    && !bag.alreadyBooked
    && !bag.slotOffer
    && !bag.replacementOffered
    && !isBookingOwnedInteraction(state.pendingInteraction)
    && state.bookingDraft != null
    && (
      state.bookingDraft.phase === "date"
      || state.bookingDraft.phase === "time"
      || state.bookingDraft.phase === "service"
    );
  if (
    !(outcomeRisk || scheduleReselectPending)
    || bag.replySource === "runtime"
    || bag.alreadyBooked
    || bag.replacementOffered
    || bag.slotOffer
    || bag.detailsStep != null
  ) {
    return;
  }

  const pendingConfirmation = agentMessages.some(
    (message) =>
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
  ) || state.pendingInteraction?.kind === "mutation_confirm";
  if (pendingConfirmation) {
    // Open ✅/❌ outranks a stale visit/DATE menu left from before HITL.
    bag.replyText = BOOKING_AWAITING_CONFIRM_UK;
    bag.replyButtons = [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL];
    bag.replySource = "runtime";
    trackEvent("reply_menu_filled", {
      menu: "mutation_confirm",
      reason: "outcome_risk",
    });
    return;
  }
  if (
    state.pendingInteraction != null
    && isBookingOwnedInteraction(state.pendingInteraction)
  ) {
    bag.replyText = String(
      renderBookingInteractionMessage(state.pendingInteraction).content,
    );
    bag.replyButtons = replyButtonsForInteraction(state.pendingInteraction);
    bag.replySource = "runtime";
    trackEvent("reply_menu_filled", {
      menu: state.pendingInteraction.kind,
      reason: "outcome_risk",
    });
    return;
  }

  const recovered = availabilityRecoveryOffer(state);
  if (recovered != null) {
    const notice = consumeServiceChangeNotice(state, bag);
    const body = bag.createError != null
      ? `${SLOT_JUST_TAKEN_PREFIX}${recovered.replyText}`
      : recovered.replyText;
    bag.replyText = notice != null ? `${notice}\n\n${body}` : body;
    bag.replyButtons = recovered.replyButtons;
    bag.availabilityInteraction = recovered.interaction;
    bag.replySource = "runtime";
    return;
  }
  if (scheduleReselectPending) {
    bag.replyText = consumeServiceChangeNotice(state, bag) ?? BOOKING_SCHEDULE_RESELECT_UK;
    bag.replyButtons = [];
    bag.replySource = "runtime";
    return;
  }
  // Uncommitted ready / details with no card — DEFAULT MENU, not error fallback.
  bag.replyText = consumeServiceChangeNotice(state, bag) ?? MAIN_MENU_GREETING_UK;
  bag.replyButtons = bag.replyButtons.length > 0
    ? bag.replyButtons
    : [...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext))];
  bag.replySource = "runtime";
  trackEvent("reply_menu_filled", { menu: "default", reason: "outcome_risk" });
};

/** Never ship model claimsOutcome unless this turn committed a meeting mutation. */
export const applyBookingFalseSuccessGuard = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  agentMessages: BaseMessage[],
  bag: BookingAiReplyBag,
): void => {
  if (
    bag.replySource === "model"
    && (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID)
    && !bag.mutationCommitted
  ) {
    const claim = claimsOutcome(bag.replyText);
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
        bag.replyText = String(
          renderBookingInteractionMessage(state.pendingInteraction).content,
        );
        bag.replyButtons = replyButtonsForInteraction(state.pendingInteraction);
        bag.replySource = "runtime";
      } else {
        bag.replyText = MAIN_MENU_GREETING_UK;
        bag.replyButtons = [
          ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
        ];
        bag.replySource = "runtime";
        trackEvent("reply_menu_filled", {
          menu: "default",
          reason: "false_success_claim",
        });
      }
    }
  }
};

export const noteStatusForHandoffUpdate = (
  state: ClinicState,
  bag: BookingAiReplyBag,
): ClinicStateUpdate =>
  bag.awaitingNote
  && !bag.slotOffer
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

export const availabilityPresentedUpdate = (
  state: ClinicState,
  bag: BookingAiReplyBag,
): ClinicStateUpdate => {
  const availabilityPresented = bag.availabilityInteraction != null
    ? reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "availability_presented", interaction: bag.availabilityInteraction },
      )
    : null;
  return availabilityPresented != null
    ? {
        pendingInteraction: availabilityPresented.pendingInteraction,
        ...(availabilityPresented.clearAvailability
          ? { availabilityContext: null, availabilityCursor: null }
          : {}),
      }
    : {};
};

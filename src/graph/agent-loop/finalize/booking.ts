import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
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
import { formatKyivDayLabel, kyivToday } from "../../../tools/availability-slots.js";
import { visitLabelForMeetingStart } from "../../../tools/visit-label.js";
import {
  bookingDraftCanPresentAvailability,
  reduceBookingDraft,
} from "../../booking-draft.js";
import {
  SLOT_JUST_TAKEN_PREFIX,
  availabilityOfferFromToolTurn,
  availabilityRecoveryOffer,
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
  resolveAvailabilityOffer,
} from "../../booking-interaction-render.js";
import {
  isBookingOwnedInteraction,
  openVisitNoteInteraction,
  openVisitReplacementInteraction,
  reduceBookingSession,
  type DateSelectInteraction,
  type TimeSelectInteraction,
} from "../../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { BOOKING_AGENT_ID } from "../../types.js";
import { bookingOutcomeRiskState } from "../booking-command.js";
import {
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
} from "../booking-note-step.js";
import {
  alreadyBookedMeetingFromMessages,
  classifyMeetingMutationToolMessage,
  createMeetingAlreadyBooked,
  latestCreateMeetingError,
  meetingMutationIsHitlDecline,
  mutationCommittedThisTurn,
} from "../protocol/index.js";
import { defaultMenuHasVisit } from "../mutation-finalize.js";
import {
  bookingDetailsInteraction,
  bookingDetailsReady,
  tryBookingContactNoAiFinalize,
} from "./contact.js";
import {
  emptyFinalizeReply,
  faqCatalogChipReply,
  type FinalizeReply,
} from "./shared.js";

/** Prefix when REPLACE cancel continues into the date/time keyboard. */
const REPLACEMENT_CANCELLED_CONTINUE_PREFIX = "Запис скасовано.";

/**
 * No-AI booking paths: contact failures, REPLACE menu, graph-owned interactions,
 * replacement-cancel availability continue. Returns null when none match.
 */
export const tryBookingNoAiFinalize = (
  state: ClinicState,
  agentMessages: BaseMessage[],
): FinalizeReply | null => {
  const contact = tryBookingContactNoAiFinalize(state);
  if (contact != null) {
    return contact;
  }

  // Identity ladder after prepare (Human-only agentMessages): phone → name
  // without an LLM turn. Owns transitions via bookingDetailsInteraction.
  const detailsStep = bookingDetailsInteraction(state);
  if (detailsStep != null) {
    return {
      ...emptyFinalizeReply("ok"),
      replyText: detailsStep.replyText,
      replyButtons: replyButtonsForInteraction(detailsStep.interaction),
      replySource: "runtime",
      patch: { pendingInteraction: detailsStep.interaction },
    };
  }

  // Graph-owned REPLACE after prepare (no LLM turn): still open the menu.
  if (state.bookingDraft?.replacement?.status === "offered") {
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
      ...emptyFinalizeReply("ok"),
      replyText,
      replyButtons,
      replySource: "runtime",
      patch: { pendingInteraction: session.pendingInteraction },
    };
  }

  // Prepare/tools opened a booking-owned menu without an LLM turn (REPLACE
  // cancel continue into catalog, book-intent family chips, or «Записатись»).
  if (
    state.pendingInteraction != null
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
    const chips = isFaqCatalog
      ? faqCatalogChipReply(interaction, state.servicesContext?.list ?? [])
      : {
          replyText: String(renderBookingInteractionMessage(interaction).content),
          replyButtons: replyButtonsForInteraction(interaction),
        };
    const replyText =
      state.pendingCancellationPurpose === "replacement"
        ? `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\n${chips.replyText}`
        : chips.replyText;
    return {
      ...emptyFinalizeReply("ok"),
      replyText,
      replyButtons: chips.replyButtons,
      replySource: "runtime",
      patch: {
        pendingInteraction: interaction,
        ...(state.pendingCancellationPurpose === "replacement"
          ? { pendingCancellationPurpose: null }
          : {}),
      },
    };
  }

  // Accepted-procedure REPLACE cancel: tools cleared pendingInteraction and
  // ran present_availability_slots. Last message is a ToolMessage — render
  // the date/time offer here so the turn does not fall through to empty.
  if (
    state.pendingCancellationPurpose === "replacement"
    && state.bookingDraft?.mode === "create"
    && state.bookingDraft.replacement == null
    && state.bookingDraft.serviceAcceptance?.status === "accepted"
  ) {
    const offer = availabilityOfferFromToolTurn(agentMessages);
    if (offer != null) {
      const replyText =
        `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\n${offer.replyText}`;
      return {
        ...emptyFinalizeReply("ok"),
        replyText,
        replyButtons: offer.replyButtons,
        replySource: "runtime",
        patch: {
          pendingCancellationPurpose: null,
          pendingInteraction: offer.interaction,
        },
      };
    }
    // Slots tool ran but produced no parseable offer — still continue the
    // booking (clear purpose) rather than the default menu.
    const replyText = `${REPLACEMENT_CANCELLED_CONTINUE_PREFIX}\n\nНа жаль, зараз немає вільних слотів. Спробуйте іншу дату.`;
    return {
      ...emptyFinalizeReply("ok"),
      replyText,
      replyButtons: [OTHER_DATE_LABEL, MAIN_MENU_LABEL],
      replySource: "runtime",
      patch: { pendingCancellationPurpose: null },
    };
  }

  return null;
};

export type BookingAiFinalizeContext = {
  state: ClinicState;
  agentMessages: BaseMessage[];
  reply: FinalizeReply;
  chatOther: boolean;
  consumeServiceChangeNotice: () => string | null;
};

export type BookingAiFinalizeFacts = {
  availabilityInteraction: DateSelectInteraction | TimeSelectInteraction | null;
  awaitingNote: boolean;
  alreadyBooked: boolean;
  createCommitted: boolean;
  mutationCommitted: boolean;
  createError: string | null | undefined;
  detailsStep: ReturnType<typeof bookingDetailsInteraction>;
  /** True when resolveAvailabilityOffer produced a card this turn. */
  slotOfferPresent: boolean;
  replacementOffered: boolean;
};

export type BookingAiFinalizeResult = {
  reply: FinalizeReply;
  /** serviceOffer → visitSelect → contactField → clearOccupied (later wins). */
  patch: ClinicStateUpdate;
  facts: BookingAiFinalizeFacts;
};

/**
 * Contact details ladder + REPLACE / already-booked / slot / pending / note /
 * default-menu rendering for the booking AI path (before FAQ / outcome-risk).
 */
export const applyBookingPrimaryReply = (
  ctx: BookingAiFinalizeContext,
): BookingAiFinalizeResult => {
  const { state, agentMessages } = ctx;
  let reply = ctx.reply;

  const detailsStep = bookingDetailsInteraction(state);
  let contactFieldUpdate: ClinicStateUpdate = {};
  if (detailsStep != null) {
    reply = {
      ...reply,
      replyText: detailsStep.replyText,
      replyButtons: replyButtonsForInteraction(detailsStep.interaction),
      replySource: "runtime",
    };
    contactFieldUpdate = { pendingInteraction: detailsStep.interaction };
  } else if (
    bookingDetailsReady(state)
    && state.pendingInteraction?.kind === "contact_field"
  ) {
    contactFieldUpdate = { pendingInteraction: null };
  }
  const clearOccupiedPhoneCandidate = detailsStep?.replyText === BOOKING_PHONE_OCCUPIED_UK
    ? { contactContext: null }
    : {};

  const alreadyBooked = createMeetingAlreadyBooked(agentMessages);
  const replacementOffered = state.bookingDraft?.replacement?.status === "offered";
  const createCommitted = agentMessages.some(
    (message) =>
      message instanceof ToolMessage
      && message.name === "create_meeting"
      && classifyMeetingMutationToolMessage(message) === "committed",
  );
  const mutationCommitted = mutationCommittedThisTurn(agentMessages);
  const createError = latestCreateMeetingError(agentMessages);
  const awaitingNote =
    authoritativeNoteStatus(state) === "awaiting"
    && authoritativeSelectedSlot(state) != null
    && !alreadyBooked;
  const slotOffer =
    !alreadyBooked
    && !createCommitted
    && bookingDraftCanPresentAvailability(state.bookingDraft)
      ? resolveAvailabilityOffer(
          agentMessages,
          state.availabilityContext,
          authoritativeSelectedSlot(state) == null,
        )
      : null;
  const requestedTimeUnavailable =
    state.bookingDraft?.requestedTime?.status === "unavailable"
    && state.bookingDraft.selectedDate != null;
  const unavailableDate = state.bookingDraft?.selectedDate;
  const unavailableTime = state.bookingDraft?.requestedTime?.value;

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
      reply = {
        ...reply,
        replyText: String(renderBookingInteractionMessage(visitInteraction).content),
        replyButtons: replyButtonsForInteraction(visitInteraction),
        replySource: "runtime",
      };
    } else {
      reply = { ...reply, replyButtons: [...BOOKING_REPLACE_MENU] };
    }
  } else if (slotOffer) {
    const unavailablePrefix = requestedTimeUnavailable
      ? `На жаль, о ${unavailableTime} на ${formatKyivDayLabel(unavailableDate!, kyivToday())} немає вільного часу.\n\n`
      : "";
    const offerBody = unavailablePrefix
      + (
        createError != null
          ? `${SLOT_JUST_TAKEN_PREFIX}${slotOffer.replyText}`
          : slotOffer.replyText
      );
    const notice = ctx.consumeServiceChangeNotice();
    reply = {
      ...reply,
      replyText: notice != null ? `${notice}\n\n${offerBody}` : offerBody,
      replyButtons: slotOffer.replyButtons,
      replySource: "runtime",
    };
    availabilityInteraction = slotOffer.interaction;
  } else if (
    state.pendingInteraction != null
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
    reply = {
      ...reply,
      replyText: String(rendered.content),
      replyButtons: replyButtonsForInteraction(state.pendingInteraction),
      replySource: "runtime",
    };
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
    reply = {
      ...reply,
      replyText: String(rendered.content),
      replyButtons: replyButtonsForInteraction(noteInteraction),
      replySource: "runtime",
    };
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
      ? visitLabelForMeetingStart(conflict.name, conflict.dateStart)
      : undefined;
    reply = {
      ...reply,
      replyText: alreadyBookedReplaceReplyUk(visitLabel),
      replyButtons: [...BOOKING_REPLACE_MENU],
      replySource: "runtime",
    };
    trackEvent("reply_menu_filled", { menu: "replace", reason: "already_booked" });
  } else if (reply.replyText.length > 0 && detailsStep == null) {
    const idle = agentMessages.some(
      (message) =>
        message instanceof ToolMessage
        && (classifyMeetingMutationToolMessage(message) === "committed"
          || meetingMutationIsHitlDecline(message)),
    );
    const cancelChatOther = ctx.chatOther
      && agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && message.name === "cancel_meeting"
          && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
      );
    if (idle) {
      reply = {
        ...reply,
        replyButtons: [
          ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
        ],
      };
      trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
    } else if (cancelChatOther) {
      reply = {
        ...reply,
        replyButtons: [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL],
      };
      trackEvent("reply_menu_filled", { menu: "mutation_confirm", reason: "cancel_chat_other" });
    } else if (
      state.pendingInteraction != null
      && isBookingOwnedInteraction(state.pendingInteraction)
    ) {
      reply = {
        ...reply,
        replyButtons: replyButtonsForInteraction(state.pendingInteraction),
      };
    } else {
      reply = { ...reply, replyButtons: [] };
    }
  }

  return {
    reply,
    patch: {
      ...serviceOfferUpdate,
      ...visitSelectUpdate,
      ...contactFieldUpdate,
      ...clearOccupiedPhoneCandidate,
    },
    facts: {
      availabilityInteraction,
      awaitingNote,
      alreadyBooked,
      createCommitted,
      mutationCommitted,
      createError,
      detailsStep,
      slotOfferPresent: slotOffer != null,
      replacementOffered,
    },
  };
};

/** Outcome-risk / schedule-reselect override for booking AI path. */
export const applyBookingOutcomeRiskOverride = (
  ctx: BookingAiFinalizeContext & BookingAiFinalizeFacts,
): {
  reply: FinalizeReply;
  availabilityInteraction: DateSelectInteraction | TimeSelectInteraction | null;
} => {
  const { state, agentMessages } = ctx;
  let reply = ctx.reply;
  let availabilityInteraction = ctx.availabilityInteraction;

  const outcomeRisk =
    !ctx.createCommitted
    && bookingOutcomeRiskState(state);
  const scheduleReselectPending =
    !ctx.createCommitted
    && !ctx.alreadyBooked
    && !ctx.slotOfferPresent
    && !ctx.replacementOffered
    && !isBookingOwnedInteraction(state.pendingInteraction)
    && state.bookingDraft != null
    && (
      state.bookingDraft.phase === "date"
      || state.bookingDraft.phase === "time"
      || state.bookingDraft.phase === "service"
    );
  if (
    (outcomeRisk || scheduleReselectPending)
    && reply.replySource !== "runtime"
    && !ctx.alreadyBooked
    && !ctx.replacementOffered
    && !ctx.slotOfferPresent
    && ctx.detailsStep == null
  ) {
    const pendingConfirmation = agentMessages.some(
      (message) =>
        message instanceof ToolMessage
        && classifyMeetingMutationToolMessage(message) === "pending_confirmation",
    ) || state.pendingInteraction?.kind === "mutation_confirm";
    if (pendingConfirmation) {
      reply = {
        ...reply,
        replyText: BOOKING_AWAITING_CONFIRM_UK,
        replyButtons: [CONFIRM_YES_LABEL, CONFIRM_NO_LABEL],
        replySource: "runtime",
      };
      trackEvent("reply_menu_filled", {
        menu: "mutation_confirm",
        reason: "outcome_risk",
      });
    } else if (
      state.pendingInteraction != null
      && isBookingOwnedInteraction(state.pendingInteraction)
    ) {
      reply = {
        ...reply,
        replyText: String(
          renderBookingInteractionMessage(state.pendingInteraction).content,
        ),
        replyButtons: replyButtonsForInteraction(state.pendingInteraction),
        replySource: "runtime",
      };
      trackEvent("reply_menu_filled", {
        menu: state.pendingInteraction.kind,
        reason: "outcome_risk",
      });
    } else {
      const recovered = availabilityRecoveryOffer(state);
      if (recovered != null) {
        const notice = ctx.consumeServiceChangeNotice();
        const body = ctx.createError != null
          ? `${SLOT_JUST_TAKEN_PREFIX}${recovered.replyText}`
          : recovered.replyText;
        reply = {
          ...reply,
          replyText: notice != null ? `${notice}\n\n${body}` : body,
          replyButtons: recovered.replyButtons,
          replySource: "runtime",
        };
        availabilityInteraction = recovered.interaction;
      } else if (scheduleReselectPending) {
        reply = {
          ...reply,
          replyText: ctx.consumeServiceChangeNotice() ?? BOOKING_SCHEDULE_RESELECT_UK,
          replyButtons: [],
          replySource: "runtime",
        };
      } else {
        reply = {
          ...reply,
          replyText: ctx.consumeServiceChangeNotice() ?? MAIN_MENU_GREETING_UK,
          replyButtons: reply.replyButtons.length > 0
            ? reply.replyButtons
            : [...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext))],
          replySource: "runtime",
        };
        trackEvent("reply_menu_filled", { menu: "default", reason: "outcome_risk" });
      }
    }
  }

  return { reply, availabilityInteraction };
};

/** Replace model prose that claims a CRM outcome the tools did not commit. */
export const applyFalseSuccessClaimOverride = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
  reply: FinalizeReply,
  mutationCommitted: boolean,
): FinalizeReply => {
  if (reply.replySource !== "model" || mutationCommitted) {
    return reply;
  }
  const claim = claimsOutcome(reply.replyText);
  if (claim == null) {
    return reply;
  }
  trackEvent("false_success_claim", {
    rule: claim.rule,
    phase: state.bookingDraft?.phase ?? null,
    agent: agentId,
  });
  if (
    agentId === BOOKING_AGENT_ID
    && state.pendingInteraction != null
    && isBookingOwnedInteraction(state.pendingInteraction)
  ) {
    return {
      ...reply,
      replyText: String(
        renderBookingInteractionMessage(state.pendingInteraction).content,
      ),
      replyButtons: replyButtonsForInteraction(state.pendingInteraction),
      replySource: "runtime",
    };
  }
  trackEvent("reply_menu_filled", {
    menu: "default",
    reason: "false_success_claim",
  });
  return {
    ...reply,
    replyText: MAIN_MENU_GREETING_UK,
    replyButtons: [
      ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
    ],
    replySource: "runtime",
  };
};

export const noteStatusHandoffUpdate = (
  state: ClinicState,
  awaitingNote: boolean,
  slotOfferPresent: boolean,
): ClinicStateUpdate => {
  if (
    awaitingNote
    && !slotOfferPresent
    && state.bookingDraft != null
    && state.bookingDraft.note.status !== "awaiting"
    && state.pendingInteraction == null
  ) {
    return {
      bookingDraft: reduceBookingDraft(state.bookingDraft, {
        type: "note_status",
        status: "awaiting",
      }),
    };
  }
  return {};
};

export const availabilityPresentedUpdate = (
  state: ClinicState,
  availabilityInteraction: DateSelectInteraction | TimeSelectInteraction | null,
): ClinicStateUpdate => {
  if (availabilityInteraction == null) {
    return {};
  }
  const availabilityPresented = reduceBookingSession(
    {
      bookingDraft: state.bookingDraft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "availability_presented", interaction: availabilityInteraction },
  );
  return {
    pendingInteraction: availabilityPresented.pendingInteraction,
    ...(availabilityPresented.clearAvailability
      ? { availabilityContext: null, availabilityCursor: null }
      : {}),
  };
};

import { AIMessage } from "@langchain/core/messages";

import {
  ABANDON_BOOKING_REPLY_UK,
  defaultMenuLabels,
  mainMenuFullGreetingUk,
  VISIT_DECLINE_REPLY_UK,
} from "../../shared/clinic-constants.js";
import type { ContactLookupContext } from "../../tools/contact-tools.js";
import { attachPrefetchVisits } from "../context/context-blocks.js";
import {
  closedBookingSessionUpdate,
  reduceBookingSession,
  type VisitSelectInteraction,
} from "../booking/booking-session.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking/booking-interaction-render.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { BOOKING_AGENT_ID, FINISH_ROUTE } from "../types.js";

export const supervisorFinishReply = (
  prefetchUpdate: ClinicStateUpdate,
  replyText: string,
  replyButtons: string[],
  pendingInteraction: ClinicState["pendingInteraction"] = null,
): ClinicStateUpdate => ({
  next: FINISH_ROUTE,
  ...prefetchUpdate,
  pendingInteraction,
  lastHandoff: {
    agentId: FINISH_ROUTE,
    agentName: "supervisor",
    status: "ok",
    replyText,
    replyButtons,
  },
  messages: [new AIMessage(replyText)],
});

/**
 * Full Main-menu GREETING; firstName only from a Telegram-owned contact.
 * Prefetch visits are injected via attachPrefetchVisits(..., "greeting").
 */
const mainMenuGreetingReply = (
  contactContext: ContactLookupContext | null | undefined,
  bookingContext: ClinicState["bookingContext"],
): string => {
  const firstName = contactContext?.ownership === "telegram"
    && typeof contactContext.contacts[0]?.firstName === "string"
    ? contactContext.contacts[0].firstName.trim()
    : "";
  return attachPrefetchVisits(
    mainMenuFullGreetingUk(firstName.length > 0 ? firstName : null),
    bookingContext,
    "greeting",
  );
};

/** Code-owned FINISH after abandoning an in-progress booking draft. */
export const abandonReply = (
  prefetchUpdate: ClinicStateUpdate,
  bookingContext: ClinicState["bookingContext"],
): ClinicStateUpdate => {
  const hasVisit = (bookingContext?.meetings.length ?? 0) > 0;
  return supervisorFinishReply(
    {
      ...prefetchUpdate,
      ...closedBookingSessionUpdate(),
    },
    ABANDON_BOOKING_REPLY_UK,
    [...defaultMenuLabels(hasVisit)],
    null,
  );
};

/** Code-owned FINISH for «Головне меню» — closes booking and restores DEFAULT MENU. */
export const mainMenuReply = (
  prefetchUpdate: ClinicStateUpdate,
  bookingContext: ClinicState["bookingContext"],
  contactContext: ClinicState["contactContext"],
): ClinicStateUpdate => {
  const hasVisit = (bookingContext?.meetings.length ?? 0) > 0;
  return supervisorFinishReply(
    {
      ...prefetchUpdate,
      ...closedBookingSessionUpdate(),
    },
    mainMenuGreetingReply(contactContext, bookingContext),
    [...defaultMenuLabels(hasVisit)],
    null,
  );
};

/**
 * Apply a resolved visit_select choice through the booking session reducer.
 * Returns null when the choice does not complete an action/meeting stage.
 */
export const applyVisitSelectChoice = (
  openVisitSelect: VisitSelectInteraction,
  choiceId: string,
  prefetchUpdate: ClinicStateUpdate,
  bookingDraft: ClinicState["bookingDraft"],
): ClinicStateUpdate | null => {
  if (openVisitSelect.stage !== "action" && openVisitSelect.stage !== "meeting") {
    return null;
  }
  if (choiceId === "decline") {
    const hasVisit = (openVisitSelect.meetings?.length ?? 0) > 0;
    return supervisorFinishReply(
      prefetchUpdate,
      VISIT_DECLINE_REPLY_UK,
      [...defaultMenuLabels(hasVisit)],
      null,
    );
  }
  const session = reduceBookingSession(
    {
      bookingDraft: bookingDraft ?? null,
      pendingInteraction: openVisitSelect,
    },
    { type: "interaction_choice", choiceId },
  );
  const nextInteraction = session.pendingInteraction;
  if (
    nextInteraction?.kind === "visit_select"
    && nextInteraction.stage === "meeting"
  ) {
    const replyText = String(renderBookingInteractionMessage(nextInteraction).content);
    return supervisorFinishReply(
      prefetchUpdate,
      replyText,
      replyButtonsForInteraction(nextInteraction),
      nextInteraction,
    );
  }
  const draft = session.bookingDraft;
  const routedToBooking = nextInteraction == null
    && (
      draft?.mode === "reschedule"
      || draft?.pendingCommand?.action === "cancel"
    );
  if (routedToBooking) {
    return {
      next: BOOKING_AGENT_ID,
      ...prefetchUpdate,
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: null,
      availabilityCursor: null,
      lastHandoff: null,
    };
  }
  return null;
};

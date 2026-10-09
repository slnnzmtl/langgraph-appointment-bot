import { AIMessage } from "@langchain/core/messages";

import {
  ABANDON_BOOKING_REPLY_UK,
  defaultMenuLabels,
  VISIT_DECLINE_REPLY_UK,
} from "../../shared/clinic-constants.js";
import {
  closedBookingSessionUpdate,
  reduceBookingSession,
  type VisitSelectInteraction,
} from "../booking-session.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking-interaction-render.js";
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

import type { ClinicState } from "../state.js";
import { type PendingBookingCommand } from "../booking-draft.js";
import { cancelCommandFromMeeting } from "../cancel-command.js";
import {
  interpretInteractionReply,
  openVisitReplacementInteraction,
} from "../booking-session.js";

import { lastPatientText } from "./shared.js";

export const replacementActionForTurn = (
  state: ClinicState,
): "cancel" | "decline" | null => {
  const replacement = state.bookingDraft?.replacement;
  if (replacement?.status !== "offered" && replacement?.status !== "cancelling") {
    return null;
  }
  const interaction =
    state.pendingInteraction?.kind === "visit_select"
    && state.pendingInteraction.stage === "replacement"
      ? state.pendingInteraction
      : openVisitReplacementInteraction(replacement.meeting);
  const match = interpretInteractionReply(interaction, lastPatientText(state));
  if (match.kind !== "choice") {
    return null;
  }
  if (match.choiceId === "cancel_existing") {
    return "cancel";
  }
  if (match.choiceId === "decline") {
    return "decline";
  }
  return null;
};

export const cancelCommandFromReplacement = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const replacement = state.bookingDraft?.replacement;
  if (!replacement) {
    return null;
  }
  return cancelCommandFromMeeting(
    replacement.meeting,
    replacement.status === "cancelling" ? { confirmationGiven: true } : {},
  );
};

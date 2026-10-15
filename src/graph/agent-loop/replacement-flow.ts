import type { ClinicState } from "../state.js";
import { type PendingBookingCommand } from "../booking-draft.js";
import { cancelCommandFromMeeting } from "../cancel-command.js";
import { labelIdFor } from "../../shared/message-content.js";
import {
  interpretInteractionReply,
  openVisitReplacementInteraction,
} from "../booking-session.js";

import { resolveContactIdentity } from "../contact-command.js";
import { lastPatientText } from "./protocol.js";

export type BookingEntryTransition =
  | {
      kind: "offer_replacement";
      meeting: NonNullable<ClinicState["bookingContext"]>["meetings"][number];
    }
  | { kind: "offer_consultation" }
  | null;

const isFreshCreateDraft = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  return draft == null
    || (
      draft.mode === "create"
      && draft.replacement == null
      && draft.pendingCommand == null
      && draft.serviceAcceptance == null
      && draft.selectedSlot == null
      && draft.selectedDate == null
    );
};

/**
 * Resolve graph-owned entry into the create flow once, before the LLM.
 *
 * Decisions use checkpoint state (meetings, draft, contact ownership, keyboard
 * labels) — not utterance regex for named vs generic booking.
 *
 * A visit action/meeting menu is superseded only by the explicit main-book
 * shortcut. Replacement and mutation confirmation are never superseded here.
 */
export const bookingEntryTransitionForTurn = (
  state: ClinicState,
): BookingEntryTransition => {
  const draft = state.bookingDraft;
  const interaction = state.pendingInteraction;
  const explicitMainBook = labelIdFor(lastPatientText(state)) === "mainBook";

  if (
    interaction?.kind === "mutation_confirm"
    || (interaction?.kind === "visit_select" && interaction.stage === "replacement")
  ) {
    return null;
  }

  const visitSelectionOpen = interaction?.kind === "visit_select";
  const canStartCreate = (draft == null || draft.mode === "create")
    && draft?.replacement == null
    && draft?.pendingCommand == null
    && (!visitSelectionOpen || explicitMainBook);
  const meeting = state.bookingContext?.meetings[0];
  if (canStartCreate && meeting != null) {
    return { kind: "offer_replacement", meeting };
  }

  if (
    !isFreshCreateDraft(state)
    || interaction?.kind === "service_confirm"
  ) {
    return null;
  }

  // Keyboard «Записатись»: consultation even when contact is unknown.
  if (explicitMainBook && (!visitSelectionOpen || explicitMainBook)) {
    return { kind: "offer_consultation" };
  }

  // Idle booking handoff with no planned visit: consultation only when the
  // Telegram contact is already owned. Unknown identity leaves the booking LLM
  // to ask for a phone.
  if (
    !visitSelectionOpen
    && (state.bookingContext?.meetings.length ?? 0) === 0
    && resolveContactIdentity(state.contactContext).kind === "owned"
  ) {
    return { kind: "offer_consultation" };
  }

  return null;
};

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

import { labelIdFor } from "../../shared/message-content.js";
import { cancelCommandFromMeeting } from "../cancel-command.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../booking-draft.js";
import type { SupervisorIntent } from "../routing.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";

export type VisitMutationAction = "cancel" | "reschedule";

export type SeedVisitMutationResult = {
  update: ClinicStateUpdate;
  draftDiscarded: boolean;
};

export const visitMutationActionForLabel = (line: string): VisitMutationAction | null => {
  const id = labelIdFor(line);
  if (id === "visitReschedule") {
    return "reschedule";
  }
  if (id === "visitCancel") {
    return "cancel";
  }
  return null;
};

export const visitMutationActionForIntent = (
  intent: SupervisorIntent | undefined,
): VisitMutationAction | null => {
  if (intent === "visit_cancel") {
    return "cancel";
  }
  if (intent === "visit_reschedule") {
    return "reschedule";
  }
  return null;
};

const draftHasProgress = (draft: BookingDraft | null | undefined): boolean =>
  draft != null
  && (
    draft.serviceAcceptance?.status === "accepted"
    || draft.selectedSlot != null
    || draft.selectedDate != null
    || draft.note.status === "answered"
    || draft.note.status === "awaiting"
  );

/**
 * Seed a cancel / reschedule draft against the single planned visit.
 * Replacement offers own their cancel through the booking agent.
 */
export const seedVisitMutation = (
  action: VisitMutationAction | null,
  bookingContext: ClinicState["bookingContext"],
  draft: ClinicState["bookingDraft"],
): SeedVisitMutationResult => {
  if (action == null) {
    return { update: {}, draftDiscarded: false };
  }
  const replacementStatus = draft?.replacement?.status;
  if (replacementStatus != null && replacementStatus !== "create_pending") {
    return { update: {}, draftDiscarded: false };
  }
  const meetings = bookingContext?.meetings ?? [];
  const meeting = meetings.length === 1 ? meetings[0] : undefined;
  if (meeting == null) {
    return { update: {}, draftDiscarded: false };
  }
  const discarded = draftHasProgress(draft);
  const baseDraft = createEmptyBookingDraft();
  if (action === "cancel") {
    return {
      update: {
        bookingDraft: reduceBookingDraft(baseDraft, {
          type: "command_prepared",
          command: cancelCommandFromMeeting(meeting),
        }),
      },
      draftDiscarded: discarded,
    };
  }
  return {
    update: {
      bookingDraft: reduceBookingDraft(baseDraft, {
        type: "reschedule_started",
        meeting,
      }),
    },
    draftDiscarded: discarded,
  };
};

import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { trackEvent } from "../../../analytics/track.js";
import { asJsonRecord } from "../../../shared/json-record.js";
import { extractMessageTextContent } from "../../../shared/message-content.js";
import { reduceBookingDraft } from "../../booking-draft.js";
import {
  closedBookingSessionUpdate,
  reduceBookingSession,
} from "../../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  alreadyBookedMeetingFromMessages,
  classifyMeetingMutationToolMessage,
  meetingMutationClearsAvailability,
  MEETING_MUTATION_TOOLS,
  type MeetingMutationOutcome,
} from "../protocol/index.js";

export type MutationProjectionResult = {
  patch: ClinicStateUpdate;
  /** When true, orchestrator must not capture/reconcile availability. */
  skipAvailability: boolean;
};

type NormalizedMutationEvent =
  | { kind: "none" }
  | {
      kind: "event";
      outcome: NonNullable<MeetingMutationOutcome>;
      message: ToolMessage;
      alreadyBooked: boolean;
      notAuthorized: boolean;
    };

/** Parse the latest meeting-mutation ToolMessage once. */
const normalizeMutationEvent = (
  resultMessages: BaseMessage[],
): NormalizedMutationEvent => {
  for (let index = resultMessages.length - 1; index >= 0; index -= 1) {
    const message = resultMessages[index];
    if (!(message instanceof ToolMessage)) {
      continue;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    if (outcome == null) {
      continue;
    }
    const record = asJsonRecord(extractMessageTextContent(message.content).trim());
    return {
      kind: "event",
      outcome,
      message,
      alreadyBooked: record?.error === "Already booked",
      notAuthorized: record?.error === "Not authorized",
    };
  }
  return { kind: "none" };
};

const committedMutationMessages = (
  resultMessages: BaseMessage[],
): ToolMessage[] =>
  resultMessages.filter(
    (entry): entry is ToolMessage =>
      entry instanceof ToolMessage
      && MEETING_MUTATION_TOOLS.has(entry.name ?? "")
      && classifyMeetingMutationToolMessage(entry) === "committed",
  );

/**
 * Auth failure, already-booked, cancel/HITL/REPLACE continue.
 * Interprets completed ToolMessages only — no hidden tool invokes, no
 * pendingCommand re-checkpoint (command_prepare owns that).
 */
export const projectMutationEffects = (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
}): MutationProjectionResult => {
  const { state, resultMessages } = input;
  const patch: ClinicStateUpdate = {};
  const event = normalizeMutationEvent(resultMessages);

  if (event.kind === "none") {
    return { patch, skipAvailability: false };
  }

  const { outcome, message, alreadyBooked, notAuthorized } = event;

  if (outcome === "blocked" && notAuthorized) {
    // The contact must be linked before this mutation can be retried. Clear
    // every projection that could reconstruct the rejected command so the
    // next route returns to identity resolution instead of replaying it.
    if (state.bookingDraft) {
      patch.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "contact_unresolved",
      });
    }
    patch.contactContext = null;
    patch.bookingContext = null;
    patch.prefetchDirty = true;
  }

  if (alreadyBooked && state.bookingDraft) {
    const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
    if (conflictMeeting) {
      patch.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "existing_booking_detected",
        meeting: conflictMeeting,
      });
    }
  }

  // pending_confirmation: command_prepare already checkpointed pendingCommand
  // and mutation_confirm — no domain reconstruction here.
  if (outcome === "pending_confirmation") {
    return { patch, skipAvailability: false };
  }

  const skipAvailability = meetingMutationClearsAvailability(resultMessages);
  if (!skipAvailability) {
    return { patch, skipAvailability: false };
  }

  patch.availabilityContext = null;
  patch.availabilityCursor = null;

  const draft =
    (Object.prototype.hasOwnProperty.call(patch, "bookingDraft")
      ? (patch.bookingDraft as typeof state.bookingDraft)
      : state.bookingDraft) ?? null;

  const committed = committedMutationMessages(resultMessages);
  const cancelOnlyCommitted =
    committed.length > 0 && committed.every((entry) => entry.name === "cancel_meeting");
  const isCancel = message.name === "cancel_meeting";
  const replacementCancelling = draft?.replacement?.status === "cancelling";

  switch (outcome) {
    case "committed": {
      if (isCancel && replacementCancelling && draft != null) {
        // REPLACE continue: complete cancel. FAQ prepare opens the catalog when
        // there is no accepted service — do not invoke list_services here.
        const completed = reduceBookingDraft(draft, {
          type: "cancel_existing_completed",
        });
        patch.bookingDraft = completed;
        patch.pendingInteraction = null;
        const cancelledId = draft.replacement!.meeting.id;
        if (state.bookingContext != null && cancelledId.length > 0) {
          patch.bookingContext = {
            ...state.bookingContext,
            meetings: state.bookingContext.meetings.filter(
              (meeting) => meeting.id !== cancelledId,
            ),
          };
        }
        break;
      }
      if (!cancelOnlyCommitted && draft) {
        Object.assign(patch, closedBookingSessionUpdate());
      }
      break;
    }
    case "declined":
    case "abandoned": {
      if (isCancel && replacementCancelling) {
        Object.assign(patch, closedBookingSessionUpdate());
        break;
      }
      if (!cancelOnlyCommitted && draft) {
        const isCreateOrReschedule =
          message.name === "create_meeting" || message.name === "reschedule_meeting";
        if (outcome === "declined" && isCreateOrReschedule && committed.length === 0) {
          const session = reduceBookingSession(
            {
              bookingDraft: draft,
              pendingInteraction: state.pendingInteraction ?? null,
            },
            { type: "draft_event", event: { type: "slot_invalidated" } },
          );
          patch.bookingDraft = session.bookingDraft;
          patch.pendingInteraction = session.pendingInteraction;
        } else {
          Object.assign(patch, closedBookingSessionUpdate());
        }
      }
      break;
    }
    case "failed": {
      if (!cancelOnlyCommitted && draft && committed.length === 0) {
        const session = reduceBookingSession(
          {
            bookingDraft: draft,
            pendingInteraction: state.pendingInteraction ?? null,
          },
          { type: "draft_event", event: { type: "slot_invalidated" } },
        );
        patch.bookingDraft = session.bookingDraft;
        patch.pendingInteraction = session.pendingInteraction;
      } else if (!cancelOnlyCommitted && draft) {
        Object.assign(patch, closedBookingSessionUpdate());
      }
      break;
    }
    case "blocked":
      // already_booked / not_authorized handled above; no further close.
      break;
    default:
      break;
  }

  if (outcome === "declined") {
    trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
  }

  return { patch, skipAvailability: true };
};

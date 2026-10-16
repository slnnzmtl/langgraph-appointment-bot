import {
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { trackEvent } from "../../../analytics/track.js";
import { asJsonRecord } from "../../../shared/json-record.js";
import { extractMessageTextContent } from "../../../shared/message-content.js";
import {
  reduceBookingDraft,
  type PendingBookingCommand,
} from "../../booking-draft.js";
import {
  closedBookingSessionUpdate,
  reduceBookingSession,
} from "../../booking-session.js";
import { cancelCommandFromStoredPayload } from "../../cancel-command.js";
import type { PartitionServiceCandidates } from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  alreadyBookedMeetingFromMessages,
  classifyMeetingMutationToolMessage,
  meetingMutationClearsAvailability,
  meetingMutationIsHitlDecline,
} from "../protocol.js";
import { applyReplacementCatalogOpen } from "./service.js";

type MutationToolEffectsOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  listServicesTool?: StructuredToolInterface;
};

/**
 * Mutation-side tool effects: pendingCancellationPurpose, awaitingConfirmation
 * persist, existing_booking_detected, and meetingMutationClearsAvailability
 * (catalog open delegated to service.applyReplacementCatalogOpen).
 */
export const applyMutationToolEffects = async (
  state: ClinicState,
  resultMessages: BaseMessage[],
  update: ClinicStateUpdate,
  options?: MutationToolEffectsOptions,
): Promise<void> => {
  const replacementCancellationResult =
    state.bookingDraft?.replacement?.status === "cancelling"
    && resultMessages.some(
      (message) => message instanceof ToolMessage && message.name === "cancel_meeting",
    );
  if (replacementCancellationResult) {
    update.pendingCancellationPurpose = "replacement";
  }

  const pendingCommand = resultMessages
    .map((message) => {
      if (!(message instanceof ToolMessage)) {
        return null;
      }
      const record = asJsonRecord(extractMessageTextContent(message.content).trim());
      const draft = asJsonRecord(record?.draft);
      const command = asJsonRecord(draft?.command);
      const payload = asJsonRecord(command?.payload);
      if (
        record?.awaitingConfirmation !== true
        || (command?.action !== "create"
          && command?.action !== "reschedule"
          && command?.action !== "replace"
          && command?.action !== "cancel")
        || payload == null
      ) {
        return null;
      }
      if (command?.action === "cancel") {
        // draft.command.payload is the CRM write, not cancel_meeting args.
        const displayName = typeof draft?.name === "string" ? draft.name : undefined;
        const displayStart = typeof draft?.dateStart === "string" ? draft.dateStart : undefined;
        const displayEnd = typeof draft?.dateEnd === "string" ? draft.dateEnd : undefined;
        return cancelCommandFromStoredPayload(payload, {
          ...(displayName ? { name: displayName } : {}),
          ...(displayStart ? { dateStart: displayStart } : {}),
          ...(displayEnd ? { dateEnd: displayEnd } : {}),
        });
      }
      return {
        action: command.action,
        payload,
      } satisfies PendingBookingCommand;
    })
    .find((command): command is PendingBookingCommand => command != null);
  const commandToPersist = pendingCommand
    && state.bookingDraft?.pendingCommand
    && state.bookingDraft.pendingCommand.action === pendingCommand.action
    ? state.bookingDraft.pendingCommand
    : pendingCommand;
  if (commandToPersist && state.bookingDraft) {
    update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "command_prepared",
      command: commandToPersist,
    });
  }

  const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
  if (conflictMeeting && state.bookingDraft) {
    update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "existing_booking_detected",
      meeting: conflictMeeting,
    });
  }

  if (!meetingMutationClearsAvailability(resultMessages)) {
    return;
  }

  const cancelCommitted = resultMessages.some(
    (message) =>
      message instanceof ToolMessage
      && message.name === "cancel_meeting"
      && classifyMeetingMutationToolMessage(message) === "committed",
  );
  const cancelDeclined = resultMessages.some(
    (message) =>
      message instanceof ToolMessage
      && message.name === "cancel_meeting"
      && meetingMutationIsHitlDecline(message),
  );

  update.availabilityContext = null;
  update.availabilityCursor = null;
  // REPLACE cancel-and-rebook: keep selectedSlot + note so create_meeting can reuse them.
  // Only skip reset when cancel_meeting is the sole committed mutation this turn.
  const committed = resultMessages.filter(
    (message): message is ToolMessage =>
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "committed",
  );
  const cancelOnlyCommitted =
    committed.length > 0 && committed.every((message) => message.name === "cancel_meeting");
  const trackHitlDecline = (): void => {
    if (
      resultMessages.some(
        (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
      )
    ) {
      trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
    }
  };

  if (cancelCommitted && state.bookingDraft?.replacement?.status === "cancelling") {
    const hadOriginal =
      state.bookingDraft.replacement.originalCommand?.action === "create"
      || state.bookingDraft.replacement.originalCommand?.action === "reschedule";
    const completed = reduceBookingDraft(state.bookingDraft, {
      type: "cancel_existing_completed",
    });
    update.bookingDraft = completed;
    // HITL card is done; do not leave mutation_confirm stuck for the continue path.
    update.pendingInteraction = null;
    const cancelledId = state.bookingDraft.replacement.meeting.id;
    if (state.bookingContext != null && cancelledId.length > 0) {
      // Prefetch is dirty but not refreshed mid-turn — drop the cancelled
      // visit so the continue LLM/prepare does not re-offer REPLACE.
      update.bookingContext = {
        ...state.bookingContext,
        meetings: state.bookingContext.meetings.filter(
          (meeting) => meeting.id !== cancelledId,
        ),
      };
    }
    if (completed != null) {
      await applyReplacementCatalogOpen(state, update, completed, hadOriginal, options);
    }
    trackHitlDecline();
    return;
  }
  if (cancelDeclined && state.bookingDraft?.replacement?.status === "cancelling") {
    Object.assign(update, closedBookingSessionUpdate());
    trackHitlDecline();
    return;
  }
  if (cancelOnlyCommitted) {
    trackHitlDecline();
    return;
  }
  if (!state.bookingDraft) {
    trackHitlDecline();
    return;
  }

  const mutationFailed = resultMessages.some(
    (message) =>
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "failed",
  );
  const mutationDeclined = resultMessages.some(
    (message) =>
      message instanceof ToolMessage
      && (message.name === "create_meeting" || message.name === "reschedule_meeting")
      && meetingMutationIsHitlDecline(message),
  );
  const mutationCommitted = committed.length > 0;
  if ((mutationFailed || mutationDeclined) && !mutationCommitted) {
    // A CRM race/error or a patient-declined booking invalidates only the
    // selected slot. Keep the accepted service and note so a later
    // availability search still uses the service duration.
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "draft_event", event: { type: "slot_invalidated" } },
    );
    update.bookingDraft = session.bookingDraft;
    update.pendingInteraction = session.pendingInteraction;
  } else {
    Object.assign(update, closedBookingSessionUpdate());
  }
  trackHitlDecline();
};

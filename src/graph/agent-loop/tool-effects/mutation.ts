import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { trackEvent } from "../../../analytics/track.js";
import { asJsonRecord } from "../../../shared/json-record.js";
import { extractMessageTextContent } from "../../../shared/message-content.js";
import { normalizeListServicesResult } from "../../../tools/service-tools.js";
import { openRootFaqCatalog } from "../../booking-entry-policy.js";
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
  meetingMutationUnauthorizedThisTurn,
} from "../protocol.js";

export type MutationProjectionOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  listServicesTool?: StructuredToolInterface;
};

export type MutationProjectionResult = {
  patch: ClinicStateUpdate;
  /** When true, orchestrator must not capture/reconcile availability. */
  skipAvailability: boolean;
};

/** Auth failure, pending command, already-booked, cancel/HITL/REPLACE catalog. */
export const projectMutationEffects = async (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
  options?: MutationProjectionOptions;
}): Promise<MutationProjectionResult> => {
  const { state, resultMessages, options } = input;
  const patch: ClinicStateUpdate = {};
  const listServicesTool = options?.listServicesTool;

  const authorizationFailure = meetingMutationUnauthorizedThisTurn(resultMessages);
  if (authorizationFailure) {
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
    patch.bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "command_prepared",
      command: commandToPersist,
    });
  }

  const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
  if (conflictMeeting && state.bookingDraft) {
    patch.bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "existing_booking_detected",
      meeting: conflictMeeting,
    });
  }

  const skipAvailability = meetingMutationClearsAvailability(resultMessages);
  if (!skipAvailability) {
    return { patch, skipAvailability: false };
  }

  patch.availabilityContext = null;
  patch.availabilityCursor = null;

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

  // Effective draft after auth / command / conflict writes above.
  const draft =
    (Object.prototype.hasOwnProperty.call(patch, "bookingDraft")
      ? (patch.bookingDraft as typeof state.bookingDraft)
      : state.bookingDraft) ?? null;

  // REPLACE cancel-and-rebook: keep selectedSlot + note so create_meeting can reuse them.
  // Only skip reset when cancel_meeting is the sole committed mutation this turn.
  const committed = resultMessages.filter(
    (message): message is ToolMessage =>
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "committed",
  );
  const cancelOnlyCommitted =
    committed.length > 0 && committed.every((message) => message.name === "cancel_meeting");
  if (cancelCommitted && draft?.replacement?.status === "cancelling") {
    const hadOriginal =
      draft.replacement.originalCommand?.action === "create"
      || draft.replacement.originalCommand?.action === "reschedule";
    const completed = reduceBookingDraft(draft, {
      type: "cancel_existing_completed",
    });
    patch.bookingDraft = completed;
    // HITL card is done; do not leave mutation_confirm stuck for the continue path.
    patch.pendingInteraction = null;
    const cancelledId = draft.replacement.meeting.id;
    if (state.bookingContext != null && cancelledId.length > 0) {
      patch.bookingContext = {
        ...state.bookingContext,
        meetings: state.bookingContext.meetings.filter(
          (meeting) => meeting.id !== cancelledId,
        ),
      };
    }
    // Pre-slot REPLACE with no accepted service — open the FAQ catalog guide
    // (same as «Обрати іншу процедуру») instead of guessing consultation.
    if (
      !hadOriginal
      && completed != null
      && completed.serviceAcceptance?.status !== "accepted"
    ) {
      let services = state.servicesContext?.list ?? [];
      if (services.length === 0 && listServicesTool != null) {
        const loaded = await listServicesTool.invoke({}).catch(() => null);
        const normalized = loaded != null
          ? normalizeListServicesResult(String(loaded))
          : null;
        if (normalized != null && normalized.list.length > 0) {
          patch.servicesContext = normalized;
          services = normalized.list;
        }
      }
      if (services.length > 0) {
        const session = await openRootFaqCatalog({
          services,
          bookingDraft: completed,
          ...(options?.partitionCandidates != null
            ? { partitionCandidates: options.partitionCandidates }
            : {}),
        });
        if (session != null) {
          patch.bookingDraft = session.bookingDraft;
          patch.pendingInteraction = session.pendingInteraction;
        }
      }
    }
  } else if (cancelDeclined && draft?.replacement?.status === "cancelling") {
    Object.assign(patch, closedBookingSessionUpdate());
  } else if (!cancelOnlyCommitted) {
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
    if (draft && (mutationFailed || mutationDeclined) && !mutationCommitted) {
      const session = reduceBookingSession(
        {
          bookingDraft: draft,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "draft_event", event: { type: "slot_invalidated" } },
      );
      patch.bookingDraft = session.bookingDraft;
      patch.pendingInteraction = session.pendingInteraction;
    } else if (draft) {
      Object.assign(patch, closedBookingSessionUpdate());
    }
  }
  if (
    resultMessages.some(
      (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
    )
  ) {
    trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
  }

  return { patch, skipAvailability: true };
};

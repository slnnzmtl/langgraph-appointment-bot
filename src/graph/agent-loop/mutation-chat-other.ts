/**
 * HITL chat-other cleanup shared by FAQ finalize (and any resume path).
 * Extracted from the deleted booking planner command module.
 */

import { AIMessage, ToolMessage } from "@langchain/core/messages";

import {
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  closedBookingSessionUpdate,
  reduceBookingSession,
} from "../booking-session.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  classifyMeetingMutationToolMessage,
  MEETING_MUTATION_TOOLS,
} from "./protocol/index.js";

const MUTATION_TOOL_NAMES = new Set([
  "create_meeting",
  "reschedule_meeting",
  "cancel_meeting",
]);

const latestMeetingMutationToolMessage = (
  messages: ClinicState["agentMessages"],
): ToolMessage | null => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = messages?.[i];
    if (
      message instanceof ToolMessage
      && typeof message.name === "string"
      && MEETING_MUTATION_TOOLS.has(message.name)
    ) {
      return message;
    }
  }
  return null;
};

export const hasPendingConfirmationChatOther = (state: ClinicState): boolean => {
  const latest = latestMeetingMutationToolMessage(state.agentMessages ?? []);
  return latest != null
    && classifyMeetingMutationToolMessage(latest) === "pending_confirmation";
};

export const applyMutationChatOtherCleanup = (state: ClinicState): ClinicStateUpdate => {
  if (state.pendingInteraction?.kind === "mutation_confirm") {
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction,
      },
      { type: "mutation_chat_other" },
    );
    const cleared = reduceBookingSession(
      {
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      },
      { type: "mutation_confirm_cleared" },
    );
    return {
      bookingDraft: cleared.bookingDraft,
      pendingInteraction: cleared.pendingInteraction,
      ...(session.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    };
  }
  if (state.bookingDraft?.pendingCommand == null) {
    return {};
  }
  const action = state.bookingDraft.pendingCommand.action;
  if (action === "create" || action === "reschedule") {
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      {
        type: "draft_event",
        event: { type: "slot_invalidated", keepDate: true },
      },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
    };
  }
  if (state.bookingDraft.replacement?.status === "cancelling") {
    return {
      ...closedBookingSessionUpdate(),
    };
  }
  return {
    bookingDraft: reduceBookingDraft(state.bookingDraft, { type: "command_cleared" }),
  };
};

export const hasMutationCallDuringUnresolvedConfirmation = (state: ClinicState): boolean => {
  if (
    state.pendingInteraction?.kind !== "mutation_confirm"
    && !hasPendingConfirmationChatOther(state)
  ) {
    return false;
  }
  const lastAi = [...(state.agentMessages ?? [])]
    .reverse()
    .find((message) => message instanceof AIMessage);
  return lastAi?.tool_calls?.some((call) => MUTATION_TOOL_NAMES.has(call.name)) === true;
};

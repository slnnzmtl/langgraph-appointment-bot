import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, Overwrite } from "@langchain/langgraph";
import { type ClinicAgentDefinition } from "../types.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import { trackEvent } from "../../analytics/track.js";
import {
  CLINIC_ADDRESS,
  CLINIC_MAPS_MARKDOWN,
  VISIT_CHANGE_MENU,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import { asJsonRecord, committedMeetingEntityId } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { reduceBookingDraft } from "../booking-draft.js";
import { closedBookingSessionUpdate } from "../booking-session.js";
import { tagRuntimeAgentMessage } from "../sub-agent-messages.js";

import {
  classifyMeetingMutationToolMessage,
  terminalMeetingMutationOutcome,
  type MeetingMutationOutcome,
} from "./protocol.js";

/** Meeting id from a committed cancel_meeting result or its tool_call args. */
const cancelledMeetingIdFromTurn = (
  messages: BaseMessage[],
  cancelResult: ToolMessage,
): string | undefined => {
  const fromResult = committedMeetingEntityId(cancelResult.content);
  if (fromResult != null) {
    return fromResult;
  }
  const callId = cancelResult.tool_call_id;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) {
      continue;
    }
    for (const call of message.tool_calls ?? []) {
      if (call.name !== "cancel_meeting") {
        continue;
      }
      if (callId && call.id != null && call.id !== callId) {
        continue;
      }
      const meetingId = (call.args as { meetingId?: unknown } | undefined)?.meetingId;
      if (typeof meetingId === "string" && meetingId.length > 0) {
        return meetingId;
      }
    }
  }
  return undefined;
};

/**
 * DEFAULT MENU hasVisit for booking finalize: committed create → true; committed cancel →
 * remaining meetings after dropping that id; else checkpointed bookingContext.
 */
export const defaultMenuHasVisit = (
  messages: BaseMessage[],
  bookingContext: BookingContext | null | undefined,
): boolean => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !(message instanceof ToolMessage)
      || (message.name !== "create_meeting" && message.name !== "cancel_meeting")
    ) {
      continue;
    }
    if (classifyMeetingMutationToolMessage(message) !== "committed") {
      return (bookingContext?.meetings.length ?? 0) > 0;
    }
    if (message.name === "create_meeting") {
      return true;
    }
    const cancelledId = cancelledMeetingIdFromTurn(messages, message);
    const remaining = (bookingContext?.meetings ?? []).filter((m) => m.id !== cancelledId);
    return remaining.length > 0;
  }
  return (bookingContext?.meetings.length ?? 0) > 0;
};

const visitLabelFromToolResult = (result: ToolMessage): string | undefined => {
  const record = asJsonRecord(extractMessageTextContent(result.content).trim());
  const visitLabel = record?.visitLabel;
  return typeof visitLabel === "string" && visitLabel.length > 0 ? visitLabel : undefined;
};

const committedCreateOrRescheduleReply = (
  verb: "створено" | "перенесено",
  visitLabel: string | undefined,
): string => {
  const headline = visitLabel != null
    ? `Готово! Запис ${verb}.\n\n${visitLabel} ✨`
    : `Готово! Запис ${verb}.`;
  return (
    headline
    + `\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`
    + "\n\nПереглянути або змінити візит можна в «Мій запис»."
  );
};

const MUTATION_REPLY_FALLBACK = "Не вдалося обробити запис. Спробуйте ще раз.";

type MutationCopyCell = string | ((replacementCancellation: boolean) => string);

const NON_COMMITTED_MUTATION_COPY: Record<
  string,
  Partial<Record<"declined" | "blocked" | "failed", MutationCopyCell>>
> = {
  create_meeting: {
    declined: "Запис не було створено.",
    blocked:
      "Не вдалося створити запис через невідповідність даних. Ваші дані збережено.",
    failed: "Не вдалося створити запис. Спробуйте ще раз.",
  },
  reschedule_meeting: {
    declined: "Запис не було перенесено.",
    failed: "Не вдалося перенести запис. Спробуйте ще раз.",
  },
  cancel_meeting: {
    declined: (replacementCancellation) =>
      replacementCancellation
        ? "Скасування поточного візиту скасовано. Новий запис не було створено."
        : "Запис не було скасовано.",
    failed: (replacementCancellation) =>
      replacementCancellation
        ? "Не вдалося скасувати поточний візит, тому новий запис не створено. Спробуйте ще раз."
        : "Не вдалося скасувати запис. Спробуйте ще раз.",
  },
};

const meetingMutationReplyText = (params: {
  mutationName: string;
  outcome: MeetingMutationOutcome;
  visitLabel?: string;
  replacementCancellation: boolean;
}): string => {
  const { mutationName, outcome, visitLabel, replacementCancellation } = params;
  if (outcome === "committed") {
    switch (mutationName) {
      case "create_meeting":
        return committedCreateOrRescheduleReply("створено", visitLabel);
      case "reschedule_meeting":
        return committedCreateOrRescheduleReply("перенесено", visitLabel);
      case "cancel_meeting":
        return "Запис скасовано.";
      default:
        return MUTATION_REPLY_FALLBACK;
    }
  }
  if (outcome === "declined" || outcome === "blocked" || outcome === "failed") {
    const cell = NON_COMMITTED_MUTATION_COPY[mutationName]?.[outcome];
    if (typeof cell === "function") {
      return cell(replacementCancellation);
    }
    if (typeof cell === "string") {
      return cell;
    }
  }
  return MUTATION_REPLY_FALLBACK;
};

/**
 * Complete a terminal meeting-mutation outcome (create / reschedule / cancel).
 * The model is intentionally not called again here: it must not turn a declined
 * write into a success message or ask for an action without supplying its keyboard.
 *
 * Main-menu leave (`abandoned`) hands control back to the supervisor so the
 * single existing main-menu path renders the greeting + default menu.
 */
export const createAgentMutationFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState, _config?: RunnableConfig): ClinicStateUpdate | Command => {
    const result = terminalMeetingMutationOutcome(state);
    if (!result) {
      return {};
    }
    const outcome = classifyMeetingMutationToolMessage(result);
    const mutationName = result.name ?? "";
    const meetingId = committedMeetingEntityId(result.content);

    if (outcome === "abandoned") {
      trackEvent("meeting_mutation_outcome", {
        mutation: mutationName,
        outcome,
      });
      return new Command({
        goto: "supervisor",
        update: {
          agentMessages: new Overwrite([] as BaseMessage[]),
          stepCount: 0,
          pendingCancellationPurpose: null,
          lastHandoff: null,
          ...closedBookingSessionUpdate(),
        },
      });
    }

    const replacementCancellation = state.pendingCancellationPurpose === "replacement";
    const replyText = meetingMutationReplyText({
      mutationName,
      outcome,
      visitLabel: outcome === "committed" ? visitLabelFromToolResult(result) : undefined,
      replacementCancellation,
    });

    const committed = outcome === "committed";
    const declined = outcome === "declined";
    const replyButtons = mutationName === "cancel_meeting" && !committed && !replacementCancellation
      ? [...VISIT_CHANGE_MENU]
      : [...defaultMenuLabels(
          committed && mutationName === "create_meeting"
            ? true
            : defaultMenuHasVisit(state.agentMessages ?? [], state.bookingContext),
        )];
    const message = tagRuntimeAgentMessage(new AIMessage(replyText), agent.id);
    trackEvent("meeting_mutation_outcome", {
      mutation: mutationName,
      outcome,
      ...(meetingId != null ? { meeting_id: meetingId } : {}),
    });
    if (committed && (mutationName === "create_meeting" || mutationName === "reschedule_meeting")) {
      trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
    }
    return {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
      // A direct cancellation is complete; do not leave its frozen command in
      // the draft for a later turn to replay.
      ...(committed || declined || mutationName === "cancel_meeting"
        ? closedBookingSessionUpdate()
        : {
            bookingDraft: state.bookingDraft
              ? reduceBookingDraft(state.bookingDraft, { type: "command_cleared" })
              : null,
          }),
      pendingCancellationPurpose: null,
      messages: [message],
      lastHandoff: {
        agentId: agent.id,
        agentName: agent.name,
        status: "ok",
        replyText,
        replyButtons,
      },
    };
  };

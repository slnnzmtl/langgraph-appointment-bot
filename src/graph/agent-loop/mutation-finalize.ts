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
import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { reduceBookingDraft } from "../booking-draft.js";
import { closedBookingSessionUpdate } from "../booking-session.js";
import { tagRuntimeAgentMessage } from "../sub-agent-messages.js";

import {
  classifyMeetingMutationToolMessage,
  terminalMeetingMutationOutcome,
} from "./shared.js";

/** Meeting id from a committed cancel_meeting result or its tool_call args. */
const cancelledMeetingIdFromTurn = (
  messages: BaseMessage[],
  cancelResult: ToolMessage,
): string | undefined => {
  const record = asJsonRecord(extractMessageTextContent(cancelResult.content).trim());
  if (typeof record?.id === "string" && record.id.length > 0) {
    return record.id;
  }
  if (typeof record?.meetingId === "string" && record.meetingId.length > 0) {
    return record.meetingId;
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

/**
 * Complete a terminal cancellation outcome. The model is intentionally not
 * called again here: it must not turn a declined write into a success message
 * or ask for an action without supplying its keyboard.
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

    const committed = outcome === "committed";
    const declined = outcome === "declined";
    const blocked = outcome === "blocked";
    const replacementCancellation = state.pendingCancellationPurpose === "replacement";
    const draftSlot = state.bookingDraft?.selectedSlot;
    const draftDate = state.bookingDraft?.selectedDate;
    const when = draftDate && draftSlot?.label ? ` на ${draftDate} о ${draftSlot.label}` : "";
    const address = `\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`;
    const replyText = mutationName === "create_meeting"
      ? committed
        ? `Готово! Запис створено${when}.${address}`
        : declined
          ? "Запис не було створено."
          : blocked
            ? "Не вдалося створити запис через невідповідність даних. Ваші дані збережено."
            : "Не вдалося створити запис. Спробуйте ще раз."
      : mutationName === "reschedule_meeting"
        ? committed
          ? `Готово! Запис перенесено${when}.${address}`
          : declined
            ? "Запис не було перенесено."
            : "Не вдалося перенести запис. Спробуйте ще раз."
        : committed
          ? "Запис скасовано."
          : declined
            ? replacementCancellation
              ? "Скасування поточного візиту скасовано. Новий запис не було створено."
              : "Запис не було скасовано."
            : replacementCancellation
              ? "Не вдалося скасувати поточний візит, тому новий запис не створено. Спробуйте ще раз."
              : "Не вдалося скасувати запис. Спробуйте ще раз.";
    const replyButtons = mutationName === "cancel_meeting" && !committed && !replacementCancellation
      ? [...VISIT_CHANGE_MENU]
      : [...defaultMenuLabels(
          committed && mutationName === "create_meeting"
            ? true
            : defaultMenuHasVisit(state.agentMessages ?? [], state.bookingContext),
        )];
    const message = tagRuntimeAgentMessage(new AIMessage(replyText), agent.id);
    const committedEntity = asJsonRecord(extractMessageTextContent(result.content).trim());
    trackEvent("meeting_mutation_outcome", {
      mutation: mutationName,
      outcome,
      ...(typeof committedEntity?.id === "string" ? { meeting_id: committedEntity.id } : {}),
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

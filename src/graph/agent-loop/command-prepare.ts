import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";

import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import { BOOKING_AGENT_ID } from "../types.js";
import { alignToAnchors, type AvailabilitySlotsToolArgs } from "../../tools/availability-tools.js";
import { kyivToday } from "../../tools/availability-slots.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import { contactMissingFields } from "../../tools/contact-tools.js";
import { extractMessageTextContent, extractReplyButtons } from "../../shared/message-content.js";
import type {
  CancellationPurpose,
  ClinicState,
  ClinicStateUpdate,
} from "../state.js";
import {
  reduceBookingDraft,
  type PendingBookingCommand,
  type BookingDraft,
} from "../booking-draft.js";
import {
  cancelCommandForSingleVisit,
  cancelConfirmationMessage,
} from "../cancel-command.js";
import { closedBookingSessionUpdate, reduceBookingSession } from "../booking-session.js";

import {
  cancelCommandFromReplacement,
  replacementActionForTurn,
} from "./replacement-flow.js";

import {
  MEETING_MUTATION_TOOLS,
  authoritativeNoteStatus,
  authoritativeSelectedSlot,
  blocksConsultationWithoutAgreement,
  bookingDateAnchors,
  bookingMutationNeedsModelRecovery,
  captureAvailabilityFromMessages,
  classifyMeetingMutationToolMessage,
  lastPatientText,
  matchAvailabilityDay,
  noteStepBlocksCreate,
  resolveContactIdentity,
  toolRanThisTurn,
} from "./shared.js";

const alignArgDates = (
  args: object,
  keys: readonly string[],
  anchors: readonly string[],
): void => {
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      record[key] = alignToAnchors(value, anchors);
    }
  }
};

type MeetingMutationCall = { name: string; args?: unknown };

/** Runtime-owned arguments used for command checkpointing and tool execution. */
export const normalizeMeetingMutationArgs = (
  state: ClinicState,
  call: MeetingMutationCall,
): Record<string, unknown> => {
  const args = {
    ...((call.args && typeof call.args === "object" && !Array.isArray(call.args))
      ? call.args as Record<string, unknown>
      : {}),
  };
  const selectedSlot = authoritativeSelectedSlot(state);
  const acceptedService = state.bookingDraft?.serviceAcceptance;
  if (call.name === "cancel_meeting") {
    // The model may request the mutation, but it does not own the safety copy
    // shown before the CRM write.
    args.confirmMessage = cancelConfirmationMessage();
  }
  if (call.name === "create_meeting" && acceptedService?.status === "accepted") {
    args.serviceId = acceptedService.service.id;
  }
  const draftContactId = state.bookingDraft?.contactId;
  const contactIdentity = resolveContactIdentity(state.contactContext, draftContactId);
  if (call.name === "create_meeting") {
    if (contactIdentity.kind === "owned") {
      args.contactId = contactIdentity.contactId;
    } else {
      delete args.contactId;
    }
  }
  if (call.name === "reschedule_meeting") {
    const target = state.bookingDraft?.mode === "reschedule"
      ? state.bookingDraft.rescheduleTarget
      : null;
    if (target && selectedSlot) {
      args.meetingId = target.id;
      args.dateStart = selectedSlot.dateStart;
      args.dateEnd = selectedSlot.dateEnd;
      args.confirmMessage = `Підтвердити перенесення візиту на ${selectedSlot.label}?`;
      if (target.name) args.name = target.name;
    }
  }
  if (selectedSlot) {
    args.dateStart = selectedSlot.dateStart;
    args.dateEnd = selectedSlot.dateEnd;
  } else {
    alignArgDates(args, ["dateStart", "dateEnd"], bookingDateAnchors(state));
  }
  return args;
};

const commandActionForTool = (name: string): "create" | "reschedule" | "replace" | "cancel" | null => {
  if (name === "create_meeting") {
    return "create";
  }
  if (name === "reschedule_meeting") {
    return "reschedule";
  }
  if (name === "cancel_meeting") {
    return "cancel";
  }
  return null;
};

/** Latest meeting-mutation ToolMessage on the agent tape, if any. */
const latestMeetingMutationToolMessage = (messages: BaseMessage[]): ToolMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof ToolMessage && MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
      return message;
    }
  }
  return null;
};

/**
 * HITL returned awaitingConfirmation (chat-other). Affirm/decline use
 * `{ confirmed }` resume and never produce this tool result when mutation_confirm
 * is open. Only the latest mutation tool result counts — a later write supersedes
 * an older awaitingConfirmation on the same tape. Do not read userReply.
 */
export const hasPendingConfirmationChatOther = (state: ClinicState): boolean => {
  const latest = latestMeetingMutationToolMessage(state.agentMessages ?? []);
  return latest != null
    && classifyMeetingMutationToolMessage(latest) === "pending_confirmation";
};

/**
 * Cancel HITL chat-other: after the model answers the unmatched ask, re-arm a
 * fresh cancel_meeting HITL (confirmationGiven false). Create/reschedule
 * chat-other stays slot-invalidate only. The awaitingConfirmation cancel_meeting
 * already ran this turn — that is expected.
 */
export const shouldRearmCancelAfterChatOther = (state: ClinicState): boolean => {
  if (!hasPendingConfirmationChatOther(state)) {
    return false;
  }
  if (
    state.pendingInteraction?.kind !== "mutation_confirm"
    || state.pendingInteraction.action !== "cancel"
  ) {
    return false;
  }
  if (
    state.pendingCancellationPurpose === "replacement"
    || state.bookingDraft?.replacement?.status === "cancelling"
    || state.bookingDraft?.replacement?.status === "offered"
    || state.bookingDraft?.replacement?.status === "create_pending"
  ) {
    return false;
  }
  return (state.bookingContext?.meetings.length ?? 0) === 1;
};

/**
 * Build cancel payload from the single planned visit, or a cancel command the
 * supervisor already seeded after a multi-visit meeting pick.
 */
const cancelCommandFromPlannedVisit = (
  state: ClinicState,
): PendingBookingCommand | null => {
  if (
    state.bookingDraft?.pendingCommand?.action === "cancel"
    && typeof state.bookingDraft.pendingCommand.payload.meetingId === "string"
  ) {
    return state.bookingDraft.pendingCommand;
  }
  return cancelCommandForSingleVisit(state.bookingContext);
};

/** Last specialist AI text on this turn (strip trailers); empty if none. */
const lastSpecialistReplyText = (state: ClinicState): string => {
  const messages = state.agentMessages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) {
      continue;
    }
    const text = extractReplyButtons(extractMessageTextContent(message.content)).text.trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "";
};

/**
 * Apply mutation_chat_other when composition resumeConfirmBookingHitl did not
 * (e.g. direct Command resume in tests). Idempotent with an already-applied update.
 */
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
      ...(state.pendingCancellationPurpose != null
        ? { pendingCancellationPurpose: null }
        : {}),
      ...(session.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    };
  }
  // Legacy resume without mutation_confirm: still abandon the frozen command.
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
  if (
    state.pendingCancellationPurpose === "replacement"
    || state.bookingDraft.replacement?.status === "cancelling"
  ) {
    return {
      ...closedBookingSessionUpdate(),
      pendingCancellationPurpose: null,
    };
  }
  return {
    bookingDraft: reduceBookingDraft(state.bookingDraft, { type: "command_cleared" }),
    ...(action === "cancel" ? { pendingCancellationPurpose: null } : {}),
  };
};

/** Replay after confirmed chat: args already carry confirmationGiven. */
export const isPendingChatConfirmationReplay = (
  state: ClinicState,
  action: "create" | "reschedule" | "cancel",
  args: unknown,
): boolean => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  return (args as Record<string, unknown>).confirmationGiven === true
    && state.bookingDraft?.pendingCommand?.action === action;
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
  return lastAi?.tool_calls?.some((call) => commandActionForTool(call.name) != null) === true;
};

/**
 * Authoritative cancel for this turn: seeded pendingCommand or direct cancel
 * intent against a single planned visit. Null while replacement / HITL owns
 * the mutation or cancel_meeting already ran.
 */
const directCancelCommandForTurn = (
  state: ClinicState,
): PendingBookingCommand | null => {
  if (state.pendingInteraction?.kind === "mutation_confirm") {
    return null;
  }
  if (toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")) {
    return null;
  }
  const replacementStatus = state.bookingDraft?.replacement?.status;
  if (
    replacementStatus === "offered"
    || replacementStatus === "cancelling"
    || replacementStatus === "create_pending"
  ) {
    return null;
  }
  const hasSeededCancel =
    state.bookingDraft?.pendingCommand?.action === "cancel"
    && typeof state.bookingDraft.pendingCommand.payload.meetingId === "string";
  if (!hasSeededCancel) {
    return null;
  }
  return cancelCommandFromPlannedVisit(state);
};

const cancellationPurposeForState = (state: ClinicState): CancellationPurpose =>
  state.bookingDraft?.replacement?.status === "offered"
    || state.bookingDraft?.replacement?.status === "cancelling"
    ? "replacement"
    : "direct";

/** Build the create command from the authoritative draft, without model-owned fields. */
const createCommandFromBookingDraft = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const draft = state.bookingDraft;
  if (draft?.replacement?.status === "offered" || draft?.replacement?.status === "cancelling") {
    return null;
  }
  if (
    draft?.replacement?.status === "create_pending"
    && draft.replacement.originalCommand?.action === "create"
  ) {
    return { ...draft.replacement.originalCommand };
  }
  const acceptance = draft?.serviceAcceptance;
  const slot = draft?.selectedSlot;
  const contactIdentity = resolveContactIdentity(state.contactContext, draft?.contactId);
  if (
    !draft
    || acceptance?.status !== "accepted"
    || slot == null
    || contactIdentity.kind !== "owned"
    || (draft.note.status !== "skipped" && draft.note.status !== "answered")
  ) {
    return null;
  }
  const { contactId, contact } = contactIdentity;
  if (contactMissingFields(contact).length > 0) {
    return null;
  }
  const firstName = typeof contact?.firstName === "string" ? contact.firstName.trim() : "";
  const lastName = typeof contact?.lastName === "string" ? contact.lastName.trim() : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const serviceName = acceptance.service.name?.trim() || acceptance.service.id;
  const payload: Record<string, unknown> = {
    name: fullName ? `${serviceName} - ${fullName}` : serviceName,
    dateStart: slot.dateStart,
    dateEnd: slot.dateEnd,
    contactId,
    serviceId: acceptance.service.id,
    confirmMessage: `Підтвердити запис на ${slot.label}?`,
    ...(draft.note.value ? { description: draft.note.value } : {}),
  };
  return { action: "create", payload };
};

/** Build a reschedule command exclusively from the CRM target and selected slot. */
const rescheduleCommandFromBookingDraft = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const draft = state.bookingDraft;
  const target = draft?.mode === "reschedule" ? draft.rescheduleTarget : null;
  const slot = draft?.selectedSlot;
  // A failed ownership check invalidates the local meeting projection. Do not
  // rebuild a reschedule command until the supervisor has prefetched a fresh,
  // Telegram-owned contact on a later turn.
  if (
    !target
    || !slot
    || (state.prefetchDirty && resolveContactIdentity(state.contactContext).kind !== "owned")
  ) return null;
  return {
    action: "reschedule",
    payload: {
      meetingId: target.id,
      dateStart: slot.dateStart,
      dateEnd: slot.dateEnd,
      confirmMessage: `Підтвердити перенесення візиту на ${slot.label}?`,
      ...(target.name ? { name: target.name } : {}),
    },
  };
};

/** Fresh tool evidence that the canonical selected slot is still bookable. */
export const freshAvailabilityValidatesSelectedSlot = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  const slot = draft?.selectedSlot;
  const availability = captureAvailabilityFromMessages(state.agentMessages ?? []);
  if (!draft || !slot || !availability) {
    return false;
  }
  if (
    draft.mode === "reschedule"
    && (!draft.rescheduleTarget
      || !availability.excludeMeetingIds?.includes(draft.rescheduleTarget.id))
  ) {
    return false;
  }
  return availability.days
    .find((day) => day.date === slot.dateStart.slice(0, 10))
    ?.slots.some((candidate) =>
      candidate.dateStart === slot.dateStart && candidate.dateEnd === slot.dateEnd,
    ) === true;
};

/** Runtime-owned exact-day lookup when DATE has no trusted snapshot day yet. */
const nearestRescheduleAvailabilityRequest = (
  state: ClinicState,
): AvailabilitySlotsToolArgs | null => {
  const draft = state.bookingDraft;
  if (
    draft?.mode !== "reschedule"
    || draft.rescheduleTarget == null
    || draft.selectedDate != null
    || toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
  ) {
    return null;
  }
  return {
    direction: "nearest",
    excludeMeetingIds: [draft.rescheduleTarget.id],
    forceRefresh: true,
  };
};

/**
 * After a mid-booking service change the old date/slot are cleared. Runtime owns
 * the next nearest availability search for the replacement service duration.
 */
const serviceChangeNearestAvailabilityRequest = (
  state: ClinicState,
): AvailabilitySlotsToolArgs | null => {
  const draft = state.bookingDraft;
  if (
    state.serviceChangeNotice == null
    || draft?.mode !== "create"
    || draft.serviceAcceptance?.status !== "accepted"
    || draft.selectedDate != null
    || draft.selectedSlot != null
    || toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
  ) {
    return null;
  }
  const durationMinutes = draft.serviceAcceptance.service.durationMinutes;
  return {
    direction: "nearest",
    forceRefresh: true,
    ...(durationMinutes != null ? { durationMinutes } : {}),
  };
};

const availabilityRequestFromBookingDraft = (
  state: ClinicState,
): AvailabilitySlotsToolArgs | null => {
  const human = lastPatientText(state);
  const request = resolveBookingScheduleRequest(human, kyivToday(), {
    availabilityContext: state.availabilityContext,
    availabilityCursor: state.availabilityCursor,
    selectedDate: state.bookingDraft?.selectedDate,
  });
  const selectedDate = state.bookingDraft?.selectedDate;
  if (
    selectedDate == null
    || toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
  ) {
    return null;
  }
  const explicitDateRequest = request?.kind === "exact" && request.date === selectedDate;
  const pickedOfferedDay = matchAvailabilityDay(
    human,
    state.availabilityContext?.days ?? [],
  ) != null;
  const dateIntentRequiresFreshLookup = explicitDateRequest && !pickedOfferedDay;
  const pendingRequestedTime = state.bookingDraft?.requestedTime?.status === "pending";
  if (!dateIntentRequiresFreshLookup && !pendingRequestedTime) {
    return null;
  }
  const durationMinutes = state.bookingDraft?.serviceAcceptance?.service.durationMinutes;
  return {
    direction: "exact",
    date: selectedDate,
    ...(state.bookingDraft?.mode === "reschedule" && state.bookingDraft.rescheduleTarget
      ? { excludeMeetingIds: [state.bookingDraft.rescheduleTarget.id] }
      : {}),
    forceRefresh: true,
    ...(durationMinutes != null ? { durationMinutes } : {}),
  };
};

const availabilitySlotsAgentMessagesUpdate = (
  messages: BaseMessage[],
  toolCallId: string,
  args: AvailabilitySlotsToolArgs,
): ClinicStateUpdate => ({
  agentMessages: new Overwrite(
    appendOrReplacePendingToolCall(messages, new AIMessage({
      content: "",
      tool_calls: [{
        id: toolCallId,
        name: "present_availability_slots",
        args,
        type: "tool_call" as const,
      }],
    })),
  ),
});

/**
 * Whether this booking turn has enough authoritative state for the runtime to
 * own the next mutation step. This deliberately ignores model output: the LLM
 * may gather missing facts, but it must not decide whether a complete booking
 * draft advances to revalidation/HITL.
 */
export const bookingTurnNeedsCommandPreparation = (state: ClinicState): boolean => {
  if (bookingMutationNeedsModelRecovery(state)) {
    return false;
  }
  // Chat-other after HITL must return to the model — never replay the frozen
  // mutation. Cancel is the exception: after the model answers (no pending
  // tool calls), re-arm HITL.
  if (hasPendingConfirmationChatOther(state)) {
    return shouldRearmCancelAfterChatOther(state)
      && !hasPendingToolCalls(state.agentMessages)
      && !lastMessageRequestsTools(state.agentMessages);
  }
  if (
    replacementActionForTurn(state) != null
    || directCancelCommandForTurn(state) != null
  ) {
    return true;
  }
  if (availabilityRequestFromBookingDraft(state) != null) {
    return true;
  }
  if (serviceChangeNearestAvailabilityRequest(state) != null) {
    return true;
  }
  if (nearestRescheduleAvailabilityRequest(state) != null) {
    return true;
  }
  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    return !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      || (
        freshAvailabilityValidatesSelectedSlot(state)
        && !toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting")
      );
  }
  if (createCommandFromBookingDraft(state) == null) {
    return false;
  }
  return !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    || freshAvailabilityValidatesSelectedSlot(state);
};

/**
 * Continue a runtime-owned compound command after its prerequisite tool step.
 * A successful revalidation can advance to create_meeting; a successful
 * contact resolution can advance to revalidation/create without a second,
 * model-authored confirmation; a successful replacement cancellation can
 * advance to revalidation/create. All other tool results still return to the
 * LLM unless they are terminal mutation outcomes.
 */
export const bookingCommandContinuesAfterTools = (state: ClinicState): boolean => {
  if (hasPendingConfirmationChatOther(state)) {
    return false;
  }
  if (state.bookingDraft?.replacement?.status === "create_pending") {
    return true;
  }
  const contactResolvedThisTurn = resolveContactIdentity(state.contactContext).kind === "owned"
    && (
      toolRanThisTurn(state.agentMessages ?? [], "create_contact")
      || toolRanThisTurn(state.agentMessages ?? [], "link_telegram_to_contact")
    );
  if (contactResolvedThisTurn && createCommandFromBookingDraft(state) != null) {
    return true;
  }
  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    return toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && freshAvailabilityValidatesSelectedSlot(state)
      && !toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting");
  }
  return toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    && createCommandFromBookingDraft(state) != null
    && freshAvailabilityValidatesSelectedSlot(state);
};

/**
 * Add a runtime-owned tool call without breaking the AI/tool protocol. Replace
 * the latest AI message only while its tool call is still pending; after a
 * fulfilled prerequisite (for example slot revalidation), append the next call.
 */
const appendOrReplacePendingToolCall = (
  messages: BaseMessage[],
  runtimeCall: AIMessage,
): BaseMessage[] => {
  if (!hasPendingToolCalls(messages)) {
    return [...messages, runtimeCall];
  }
  const lastAiIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message instanceof AIMessage)?.index;
  return lastAiIndex == null
    ? [...messages, runtimeCall]
    : [
        ...messages.slice(0, lastAiIndex),
        runtimeCall,
        ...messages.slice(lastAiIndex + 1),
      ];
};

/** Open mutation_confirm in the same node return as the mutation tool call. */
const withMutationConfirm = (
  state: ClinicState,
  action: "create" | "reschedule" | "cancel",
  update: ClinicStateUpdate,
): ClinicStateUpdate => {
  const session = reduceBookingSession(
    {
      bookingDraft: (update.bookingDraft as BookingDraft | null | undefined)
        ?? state.bookingDraft
        ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "mutation_confirm_opened", action },
  );
  return {
    ...update,
    pendingInteraction: session.pendingInteraction,
  };
};

/**
 * Checkpoint the normalized mutation command before ToolNode can reach HITL.
 * LangGraph does not apply a node's return value when a later node interrupts,
 * so preparing this in the tools node is too late for restart-safe confirmation.
 */
export const createAgentCommandPrepareNode = (agentId: string) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    if (agentId !== BOOKING_AGENT_ID) {
      return {};
    }
    // Cancel chat-other: re-arm a fresh cancel HITL after the unmatched ask was
    // answered. Create/reschedule chat-other must not prepare/replay.
    if (hasPendingConfirmationChatOther(state)) {
      if (!shouldRearmCancelAfterChatOther(state)) {
        return {};
      }
      const messages = state.agentMessages ?? [];
      const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
      const pendingCalls = lastAi?.tool_calls ?? [];
      const nonMutationCalls = pendingCalls.filter(
        (call) => commandActionForTool(call.name) == null,
      );
      // Price/catalog lookups must finish before re-arming cancel HITL.
      if (
        nonMutationCalls.length > 0
        && (hasPendingToolCalls(messages) || lastMessageRequestsTools(messages))
      ) {
        if (nonMutationCalls.length === pendingCalls.length) {
          return {};
        }
        const strippedAi = new AIMessage({
          content: lastAi!.content,
          tool_calls: nonMutationCalls,
          additional_kwargs: lastAi!.additional_kwargs,
          response_metadata: lastAi!.response_metadata,
          id: lastAi!.id,
        } as ConstructorParameters<typeof AIMessage>[0]);
        const lastIndex = messages.lastIndexOf(lastAi!);
        return {
          agentMessages: new Overwrite([
            ...messages.slice(0, lastIndex),
            strippedAi,
            ...messages.slice(lastIndex + 1),
          ]),
        };
      }
      const rearmCancel = cancelCommandFromPlannedVisit(state);
      if (rearmCancel == null) {
        return {};
      }
      const answerText = lastSpecialistReplyText(state);
      const syntheticCall = {
        id: `booking_cancel_rearm_${state.bookingDraft?.version ?? 0}`,
        name: "cancel_meeting",
        args: rearmCancel.payload,
        type: "tool_call" as const,
      };
      const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
      const prepared = withMutationConfirm(state, "cancel", {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: rearmCancel,
        }),
        pendingCancellationPurpose: "direct",
        agentMessages: new Overwrite(appendOrReplacePendingToolCall(messages, syntheticAi)),
      });
      return {
        ...prepared,
        ...(answerText.length > 0
          ? {
              lastHandoff: {
                agentId: BOOKING_AGENT_ID,
                agentName: "booking",
                status: "ok" as const,
                replyText: answerText,
              },
            }
          : {}),
      };
    }
    // Replacement is a compound mutation. Once it has started, the original
    // patient message (often `Скасувати`) and the stale meeting snapshot must
    // not be interpreted as a new direct-cancellation request. The replacement
    // phase is the authoritative source for the next command.
    const directCancelCommand = directCancelCommandForTurn(state);
    if (directCancelCommand) {
      const syntheticCall = {
        id: `booking_direct_cancel_${state.bookingDraft?.version ?? 0}`,
        name: "cancel_meeting",
        args: directCancelCommand.payload,
        type: "tool_call" as const,
      };
      const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
      const messages = state.agentMessages ?? [];
      return withMutationConfirm(state, "cancel", {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: directCancelCommand,
        }),
        pendingCancellationPurpose: "direct",
        agentMessages: new Overwrite(appendOrReplacePendingToolCall(messages, syntheticAi)),
      });
    }
    const replacementAction = replacementActionForTurn(state);
    if (replacementAction === "decline") {
      return {
        ...closedBookingSessionUpdate(),
        agentMessages: new Overwrite([]),
      };
    }
    if (replacementAction === "cancel") {
      const cancelCommand = cancelCommandFromReplacement(state);
      if (cancelCommand) {
        const syntheticCall = {
          id: `booking_replace_cancel_${state.bookingDraft?.version ?? 0}`,
          name: "cancel_meeting",
          args: cancelCommand.payload,
          type: "tool_call" as const,
        };
        const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
        const messages = state.agentMessages ?? [];
        return withMutationConfirm(state, "cancel", {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "cancel_existing_requested",
            command: cancelCommand,
          }),
          pendingCancellationPurpose: "replacement",
          agentMessages: new Overwrite(appendOrReplacePendingToolCall(messages, syntheticAi)),
        });
      }
    }
    if (
      state.bookingDraft?.replacement?.status === "offered"
      || state.bookingDraft?.replacement?.status === "cancelling"
    ) {
      return {};
    }
    const nearestRescheduleRequest = nearestRescheduleAvailabilityRequest(state);
    if (nearestRescheduleRequest) {
      return availabilitySlotsAgentMessagesUpdate(
        state.agentMessages ?? [],
        `booking_reschedule_nearest_${state.bookingDraft?.version ?? 0}`,
        nearestRescheduleRequest,
      );
    }
    const serviceChangeNearestRequest = serviceChangeNearestAvailabilityRequest(state);
    if (serviceChangeNearestRequest) {
      return availabilitySlotsAgentMessagesUpdate(
        state.agentMessages ?? [],
        `booking_service_change_nearest_${state.bookingDraft?.version ?? 0}`,
        serviceChangeNearestRequest,
      );
    }
    const availabilityRequest = availabilityRequestFromBookingDraft(state);
    if (availabilityRequest) {
      return availabilitySlotsAgentMessagesUpdate(
        state.agentMessages ?? [],
        `booking_availability_${state.bookingDraft?.version ?? 0}`,
        availabilityRequest,
      );
    }
    const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
    if (
      rescheduleCommand
      && !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    ) {
      const revalidationCall = {
        id: `booking_reschedule_revalidate_${state.bookingDraft?.version ?? 0}`,
        name: "present_availability_slots",
        args: {
          direction: "exact",
          date: state.bookingDraft?.selectedDate,
          excludeMeetingIds: [state.bookingDraft!.rescheduleTarget!.id],
          forceRefresh: true,
        },
        type: "tool_call" as const,
      };
      const revalidationAi = new AIMessage({ content: "", tool_calls: [revalidationCall] });
      return {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: rescheduleCommand,
        }),
        agentMessages: new Overwrite(
          appendOrReplacePendingToolCall(state.agentMessages ?? [], revalidationAi),
        ),
      };
    }
    if (
      rescheduleCommand
      && freshAvailabilityValidatesSelectedSlot(state)
      && !toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting")
    ) {
      const syntheticCall = {
        id: `booking_reschedule_${state.bookingDraft?.version ?? 0}`,
        name: "reschedule_meeting",
        args: rescheduleCommand.payload,
        type: "tool_call" as const,
      };
      const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
      return withMutationConfirm(state, "reschedule", {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: rescheduleCommand,
        }),
        agentMessages: new Overwrite(
          appendOrReplacePendingToolCall(state.agentMessages ?? [], syntheticAi),
        ),
      });
    }
    const draftCommand = createCommandFromBookingDraft(state);
    if (
      draftCommand
      && !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && state.bookingDraft?.selectedDate
    ) {
      const revalidationCall = {
        id: `booking_revalidate_${state.bookingDraft.version}`,
        name: "present_availability_slots",
        args: {
          direction: "exact",
          date: state.bookingDraft.selectedDate,
          ...(state.bookingDraft.serviceAcceptance?.service.durationMinutes
            ? { durationMinutes: state.bookingDraft.serviceAcceptance.service.durationMinutes }
            : {}),
          forceRefresh: true,
        },
        type: "tool_call" as const,
      };
      const revalidationAi = new AIMessage({
        content: "",
        tool_calls: [revalidationCall],
      });
      const messages = state.agentMessages ?? [];
      return {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: draftCommand,
        }),
        agentMessages: new Overwrite(
          appendOrReplacePendingToolCall(messages, revalidationAi),
        ),
      };
    }
    if (draftCommand && freshAvailabilityValidatesSelectedSlot(state)) {
      const syntheticCall = {
        id: `booking_draft_create_${state.bookingDraft?.version ?? 0}`,
        name: "create_meeting",
        args: draftCommand.payload,
        type: "tool_call" as const,
      };
      const syntheticAi = new AIMessage({
        content: "",
        tool_calls: [syntheticCall],
      });
      const messages = state.agentMessages ?? [];
      return withMutationConfirm(state, "create", {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: draftCommand,
        }),
        agentMessages: new Overwrite(appendOrReplacePendingToolCall(messages, syntheticAi)),
      });
    }
    const lastAi = [...(state.agentMessages ?? [])]
      .reverse()
      .find((message) => message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0);
    if (!(lastAi instanceof AIMessage)) {
      return {};
    }
    const calls = (lastAi.tool_calls ?? [])
      .filter((call) => commandActionForTool(call.name) != null);
    if (calls.length === 0) {
      return {};
    }
    const call = calls[0]!;
    const action = commandActionForTool(call.name)!;
    if (
      call.name === "create_meeting"
      && (
        noteStepBlocksCreate(authoritativeNoteStatus(state))
        || blocksConsultationWithoutAgreement(agentId, call, state)
      )
    ) {
      return {};
    }
    const payload = normalizeMeetingMutationArgs(state, call);
    const command: PendingBookingCommand = { action, payload };
    const bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "command_prepared",
      command,
    });
    const normalizedCalls = (lastAi.tool_calls ?? []).map((candidate) =>
      candidate === call ? { ...candidate, args: payload } : candidate,
    );
    const normalizedAi = new AIMessage({
      content: lastAi.content,
      tool_calls: normalizedCalls,
      additional_kwargs: lastAi.additional_kwargs,
      response_metadata: lastAi.response_metadata,
      id: lastAi.id,
    } as ConstructorParameters<typeof AIMessage>[0]);
    const lastIndex = state.agentMessages.lastIndexOf(lastAi);
    const update: ClinicStateUpdate = {
      bookingDraft,
      ...(action === "cancel"
        ? { pendingCancellationPurpose: cancellationPurposeForState(state) }
        : {}),
      agentMessages: new Overwrite([
        ...state.agentMessages.slice(0, lastIndex),
        normalizedAi,
        ...state.agentMessages.slice(lastIndex + 1),
      ]),
    };
    // Open mutation_confirm only when this node appends/normalizes a mutation
    // tool call (never on the present_availability revalidation branch above).
    if (action === "create" || action === "reschedule" || action === "cancel") {
      return withMutationConfirm(state, action, update);
    }
    return update;
  };

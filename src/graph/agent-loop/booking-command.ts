import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";

import { trackEvent } from "../../analytics/track.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import { BOOKING_AGENT_ID } from "../types.js";
import type { AvailabilitySlotsToolArgs } from "../../tools/availability-tools.js";
import { contactMissingFields } from "../../tools/contact-tools.js";
import type {
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
  cancelCommandFromMeeting,
  cancelCommandFromStoredPayload,
} from "../cancel-command.js";
import {
  closedBookingSessionUpdate,
  openContactFieldInteraction,
  openVisitNoteInteraction,
  reduceBookingSession,
} from "../booking-session.js";
import {
  contactCommandNeedsToolInjection,
  contactCommandReadyForInjection,
  resolveContactCommand,
  type ContactCommand,
} from "../contact-command.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent, extractReplyButtons } from "../../shared/message-content.js";

import {
  cancelCommandFromReplacement,
  replacementActionForTurn,
} from "./replacement-flow.js";
import {
  exactRevalidateRequest,
  resolveRuntimeAvailabilityRequest,
  type RuntimeAvailabilityPurpose,
} from "./availability-request.js";
import {
  MEETING_MUTATION_TOOLS,
  classifyMeetingMutationToolMessage,
  resolveContactIdentity,
  phoneLookupFailedThisTurn,
  toolRanThisTurn,
  bookingMutationNeedsModelRecovery,
  terminalContactWriteOutcome,
  noteStepBlocksCreate,
  authoritativeNoteStatus,
  captureAvailabilityFromMessages,
} from "./shared.js";

export const RUNTIME_TOOL_ORIGIN = "command_prepare" as const;

export type RuntimeToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  action?: string;
};

export type BookingGuardReason =
  | "note_required"
  | "stale_slot"
  | "missing_exact_date"
  | "contact_field";

export type BookingCommandOutcome =
  | { kind: "execute"; toolCall: RuntimeToolCall; update: ClinicStateUpdate }
  | { kind: "render"; reason: BookingGuardReason; update: ClinicStateUpdate }
  | { kind: "none"; update?: ClinicStateUpdate };

/** Stamp runtime-originated tool calls without PII or tool args. */
export const stampRuntimeToolAi = (
  toolName: string,
  toolCalls: NonNullable<AIMessage["tool_calls"]>,
  action?: string,
): AIMessage => {
  trackEvent("booking_runtime_tool", {
    tool: toolName,
    origin: RUNTIME_TOOL_ORIGIN,
    ...(action != null ? { action } : {}),
  });
  return new AIMessage({
    content: "",
    tool_calls: toolCalls,
    additional_kwargs: { runtimeToolOrigin: RUNTIME_TOOL_ORIGIN },
  });
};

export const isRuntimeOriginatedToolAi = (message: AIMessage): boolean =>
  message.additional_kwargs?.runtimeToolOrigin === RUNTIME_TOOL_ORIGIN;

/**
 * Add a runtime-owned tool call without breaking the AI/tool protocol. Replace
 * the latest AI message only while its tool call is still pending; after a
 * fulfilled prerequisite (for example slot revalidation), append the next call.
 */
export const appendOrReplacePendingToolCall = (
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
export const withMutationConfirm = (
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

const latestMeetingMutationToolMessage = (messages: BaseMessage[]): ToolMessage | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof ToolMessage && MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
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

export const cancelCommandFromAwaitingConfirmation = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const latest = latestMeetingMutationToolMessage(state.agentMessages ?? []);
  if (
    latest == null
    || latest.name !== "cancel_meeting"
    || classifyMeetingMutationToolMessage(latest) !== "pending_confirmation"
  ) {
    return null;
  }
  const record = asJsonRecord(extractMessageTextContent(latest.content));
  const draft = asJsonRecord(record?.draft);
  const command = asJsonRecord(draft?.command);
  const fromDraft = asJsonRecord(command?.payload);
  if (typeof fromDraft?.meetingId === "string" && fromDraft.meetingId.trim().length > 0) {
    return cancelCommandFromMeeting({
      id: fromDraft.meetingId.trim(),
      ...(typeof fromDraft.name === "string" ? { name: fromDraft.name } : {}),
      ...(typeof fromDraft.dateStart === "string" ? { dateStart: fromDraft.dateStart } : {}),
      ...(typeof fromDraft.dateEnd === "string" ? { dateEnd: fromDraft.dateEnd } : {}),
    });
  }
  const callId = latest.tool_call_id;
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof AIMessage)) {
      continue;
    }
    const call = message.tool_calls?.find((entry) => entry.id === callId);
    if (call == null || call.name !== "cancel_meeting") {
      continue;
    }
    const args = asJsonRecord(call.args);
    if (typeof args?.meetingId === "string" && args.meetingId.trim().length > 0) {
      return cancelCommandFromMeeting({
        id: args.meetingId.trim(),
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(typeof args.dateStart === "string" ? { dateStart: args.dateStart } : {}),
        ...(typeof args.dateEnd === "string" ? { dateEnd: args.dateEnd } : {}),
      });
    }
  }
  return null;
};

export const shouldRearmCancelAfterChatOther = (state: ClinicState): boolean => {
  if (!hasPendingConfirmationChatOther(state)) {
    return false;
  }
  const latest = latestMeetingMutationToolMessage(state.agentMessages ?? []);
  if (latest?.name !== "cancel_meeting") {
    return false;
  }
  if (
    state.pendingInteraction?.kind === "mutation_confirm"
    && state.pendingInteraction.action !== "cancel"
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
  return cancelCommandFromPlannedVisit(state) != null;
};

const cancelCommandFromPlannedVisit = (
  state: ClinicState,
): PendingBookingCommand | null => {
  if (state.bookingDraft?.pendingCommand?.action === "cancel") {
    const rebuilt = cancelCommandFromStoredPayload(state.bookingDraft.pendingCommand.payload);
    if (rebuilt != null) {
      return rebuilt;
    }
  }
  return cancelCommandForSingleVisit(state.bookingContext)
    ?? cancelCommandFromAwaitingConfirmation(state);
};

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

/** Build the create command from the authoritative draft, without model-owned fields. */
export const createCommandFromBookingDraft = (
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

/** True when create is blocked only by the optional visit-note step. */
const createBlockedOnlyByNote = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  if (
    draft == null
    || draft.mode !== "create"
    || !noteStepBlocksCreate(authoritativeNoteStatus(state))
  ) {
    return false;
  }
  const acceptance = draft.serviceAcceptance;
  const slot = draft.selectedSlot;
  const contactIdentity = resolveContactIdentity(state.contactContext, draft.contactId);
  return (
    acceptance?.status === "accepted"
    && slot != null
    && contactIdentity.kind === "owned"
    && contactMissingFields(contactIdentity.contact).length === 0
  );
};

/** Build a reschedule command exclusively from the CRM target and selected slot. */
export const rescheduleCommandFromBookingDraft = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const draft = state.bookingDraft;
  const target = draft?.mode === "reschedule" ? draft.rescheduleTarget : null;
  const slot = draft?.selectedSlot;
  if (
    !target
    || !slot
    || (state.prefetchDirty && resolveContactIdentity(state.contactContext).kind !== "owned")
  ) {
    return null;
  }
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

const contactToolCallFromCommand = (
  command: ContactCommand,
  draftVersion: number,
): RuntimeToolCall | null => {
  switch (command.action) {
    case "lookup":
      return {
        id: `booking_contact_lookup_${draftVersion}`,
        name: "find_contact_by_phone",
        args: { phoneNumber: command.phoneNumber },
        action: "lookup",
      };
    case "link":
      return {
        id: `booking_contact_link_${draftVersion}`,
        name: "link_telegram_to_contact",
        args: { contactId: command.contactId },
        action: "link",
      };
    case "create":
      return {
        id: `booking_contact_create_${draftVersion}`,
        name: "create_contact",
        args: {
          firstName: command.details.firstName,
          lastName: command.details.lastName,
          phoneNumber: command.details.phoneNumber,
        },
        action: "create",
      };
    case "update":
      return {
        id: `booking_contact_update_${draftVersion}`,
        name: "update_contact",
        args: {
          contactId: command.contactId,
          ...command.fields,
        },
        action: "update",
      };
    default:
      return null;
  }
};

const executeToolOutcome = (
  state: ClinicState,
  toolCall: RuntimeToolCall,
  update: ClinicStateUpdate = {},
): BookingCommandOutcome => {
  const stamped = stampRuntimeToolAi(
    toolCall.name,
    [{
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      type: "tool_call" as const,
    }],
    toolCall.action,
  );
  return {
    kind: "execute",
    toolCall,
    update: {
      ...update,
      agentMessages: new Overwrite(
        appendOrReplacePendingToolCall(state.agentMessages ?? [], stamped),
      ),
    },
  };
};

const availabilityExecute = (
  state: ClinicState,
  args: AvailabilitySlotsToolArgs,
  purpose: RuntimeAvailabilityPurpose,
  toolCallId: string,
  update: ClinicStateUpdate = {},
): BookingCommandOutcome =>
  executeToolOutcome(
    state,
    {
      id: toolCallId,
      name: "present_availability_slots",
      args: args as Record<string, unknown>,
      action: purpose,
    },
    update,
  );

const staleSlotRender = (state: ClinicState): BookingCommandOutcome => {
  const session = reduceBookingSession(
    {
      bookingDraft: state.bookingDraft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    {
      type: "draft_event",
      event: { type: "slot_invalidated", keepDate: true },
    },
  );
  trackEvent("booking_invariant_violation", { reason: "stale_slot" });
  return {
    kind: "render",
    reason: "stale_slot",
    update: {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
      availabilityContext: null,
      availabilityCursor: null,
    },
  };
};

/**
 * Pure booking transition: availability, contact, mutations, or a renderable
 * guard. Does not write a durable outcome onto checkpoint state.
 */
export const resolveBookingCommand = (state: ClinicState): BookingCommandOutcome => {
  if (hasPendingConfirmationChatOther(state)) {
    if (!shouldRearmCancelAfterChatOther(state)) {
      return { kind: "none" };
    }
    const messages = state.agentMessages ?? [];
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    const pendingCalls = lastAi?.tool_calls ?? [];
    const nonMutationCalls = pendingCalls.filter(
      (call) => commandActionForTool(call.name) == null,
    );
    if (
      nonMutationCalls.length > 0
      && (hasPendingToolCalls(messages) || lastMessageRequestsTools(messages))
    ) {
      if (nonMutationCalls.length === pendingCalls.length) {
        return { kind: "none" };
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
        kind: "none",
        update: {
          agentMessages: new Overwrite([
            ...messages.slice(0, lastIndex),
            strippedAi,
            ...messages.slice(lastIndex + 1),
          ]),
        },
      };
    }
    const rearmCancel = cancelCommandFromPlannedVisit(state);
    if (rearmCancel == null) {
      return { kind: "none" };
    }
    const answerText = lastSpecialistReplyText(state);
    const toolCall: RuntimeToolCall = {
      id: `booking_cancel_rearm_${state.bookingDraft?.version ?? 0}`,
      name: "cancel_meeting",
      args: rearmCancel.payload,
      action: "cancel_rearm",
    };
    const prepared = withMutationConfirm(state, "cancel", {
      bookingDraft: reduceBookingDraft(state.bookingDraft, {
        type: "command_prepared",
        command: rearmCancel,
      }),
      pendingCancellationPurpose: "direct",
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
    });
    return executeToolOutcome(state, toolCall, prepared);
  }

  const directCancelCommand = directCancelCommandForTurn(state);
  if (directCancelCommand) {
    const toolCall: RuntimeToolCall = {
      id: `booking_direct_cancel_${state.bookingDraft?.version ?? 0}`,
      name: "cancel_meeting",
      args: directCancelCommand.payload,
      action: "cancel",
    };
    return executeToolOutcome(
      state,
      toolCall,
      withMutationConfirm(state, "cancel", {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: directCancelCommand,
        }),
        pendingCancellationPurpose: "direct",
      }),
    );
  }

  const replacementAction = replacementActionForTurn(state);
  if (replacementAction === "decline") {
    return {
      kind: "none",
      update: {
        ...closedBookingSessionUpdate(),
        agentMessages: new Overwrite([]),
      },
    };
  }
  if (replacementAction === "cancel") {
    const cancelCommand = cancelCommandFromReplacement(state);
    if (cancelCommand) {
      const toolCall: RuntimeToolCall = {
        id: `booking_replace_cancel_${state.bookingDraft?.version ?? 0}`,
        name: "cancel_meeting",
        args: cancelCommand.payload,
        action: "replace_cancel",
      };
      return executeToolOutcome(
        state,
        toolCall,
        withMutationConfirm(state, "cancel", {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "cancel_existing_requested",
            command: cancelCommand,
          }),
          pendingCancellationPurpose: "replacement",
        }),
      );
    }
  }
  if (
    state.bookingDraft?.replacement?.status === "offered"
    || state.bookingDraft?.replacement?.status === "cancelling"
  ) {
    return { kind: "none" };
  }

  // Availability before contact so service-change / date intent can refresh
  // slots without blocking on the identity ladder.
  const availability = resolveRuntimeAvailabilityRequest(state);
  if (availability != null) {
    return availabilityExecute(
      state,
      availability.args,
      availability.purpose,
      `booking_${availability.purpose}_${state.bookingDraft?.version ?? 0}`,
    );
  }

  if (contactCommandReadyForInjection(state)) {
    const command = resolveContactCommand(state);
    // Reschedule does not collect contact identity — skip request_field and
    // continue to mutation. Create still renders the keyboard.
    if (
      command.action === "request_field"
      && state.bookingDraft?.mode !== "reschedule"
    ) {
      return {
        kind: "render",
        reason: "contact_field",
        update: {
          pendingInteraction: openContactFieldInteraction(
            command.field,
            command.occupied === true,
          ),
        },
      };
    }
    if (contactCommandNeedsToolInjection(command) && !hasPendingToolCalls(state.agentMessages)) {
      const toolCall = contactToolCallFromCommand(
        command,
        state.bookingDraft?.version ?? 0,
      );
      if (toolCall != null) {
        return executeToolOutcome(state, toolCall);
      }
    }
  }

  if (createBlockedOnlyByNote(state)) {
    trackEvent("booking_create_blocked_note", {
      phase: authoritativeNoteStatus(state),
    });
    const draft = state.bookingDraft;
    return {
      kind: "render",
      reason: "note_required",
      update: {
        ...(draft
          ? {
              bookingDraft: reduceBookingDraft(draft, {
                type: "note_status",
                status: "awaiting",
              }),
            }
          : {}),
        pendingInteraction: openVisitNoteInteraction(),
      },
    };
  }

  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    if (!toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")) {
      const revalidate = exactRevalidateRequest(state, "reschedule_revalidate");
      if (revalidate == null) {
        return { kind: "render", reason: "missing_exact_date", update: {} };
      }
      return availabilityExecute(
        state,
        revalidate.args,
        revalidate.purpose,
        `booking_reschedule_revalidate_${state.bookingDraft?.version ?? 0}`,
        {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "command_prepared",
            command: rescheduleCommand,
          }),
        },
      );
    }
    if (!freshAvailabilityValidatesSelectedSlot(state)) {
      return staleSlotRender(state);
    }
    if (!toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting")) {
      return executeToolOutcome(
        state,
        {
          id: `booking_reschedule_${state.bookingDraft?.version ?? 0}`,
          name: "reschedule_meeting",
          args: rescheduleCommand.payload,
          action: "reschedule",
        },
        withMutationConfirm(state, "reschedule", {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "command_prepared",
            command: rescheduleCommand,
          }),
        }),
      );
    }
  }

  const draftCommand = createCommandFromBookingDraft(state);
  if (draftCommand != null) {
    if (
      !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && state.bookingDraft?.selectedDate
    ) {
      const revalidate = exactRevalidateRequest(state, "create_revalidate");
      if (revalidate == null) {
        return { kind: "render", reason: "missing_exact_date", update: {} };
      }
      return availabilityExecute(
        state,
        revalidate.args,
        revalidate.purpose,
        `booking_revalidate_${state.bookingDraft.version}`,
        {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "command_prepared",
            command: draftCommand,
          }),
        },
      );
    }
    if (toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && !freshAvailabilityValidatesSelectedSlot(state)) {
      return staleSlotRender(state);
    }
    if (freshAvailabilityValidatesSelectedSlot(state)) {
      return executeToolOutcome(
        state,
        {
          id: `booking_draft_create_${state.bookingDraft?.version ?? 0}`,
          name: "create_meeting",
          args: draftCommand.payload,
          action: "create",
        },
        withMutationConfirm(state, "create", {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "command_prepared",
            command: draftCommand,
          }),
        }),
      );
    }
  }

  return { kind: "none" };
};

export const bookingTurnNeedsCommandPreparation = (state: ClinicState): boolean => {
  if (bookingMutationNeedsModelRecovery(state)) {
    return false;
  }
  if (phoneLookupFailedThisTurn(state)) {
    return false;
  }
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
  if (contactCommandReadyForInjection(state)) {
    const command = resolveContactCommand(state);
    if (contactCommandNeedsToolInjection(command)) {
      return true;
    }
    if (
      command.action === "request_field"
      && state.bookingDraft?.mode !== "reschedule"
    ) {
      return true;
    }
  }
  if (resolveRuntimeAvailabilityRequest(state) != null) {
    return true;
  }
  if (createBlockedOnlyByNote(state)) {
    return true;
  }
  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    return !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      || (
        freshAvailabilityValidatesSelectedSlot(state)
        && !toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting")
      )
      || (
        toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
        && !freshAvailabilityValidatesSelectedSlot(state)
      );
  }
  if (createCommandFromBookingDraft(state) == null) {
    return false;
  }
  return !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    || freshAvailabilityValidatesSelectedSlot(state)
    || (
      toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && !freshAvailabilityValidatesSelectedSlot(state)
    );
};

export const bookingCommandContinuesAfterTools = (state: ClinicState): boolean => {
  if (hasPendingConfirmationChatOther(state)) {
    return false;
  }
  if (terminalContactWriteOutcome(state) != null || phoneLookupFailedThisTurn(state)) {
    return false;
  }
  if (state.bookingDraft?.replacement?.status === "create_pending") {
    return true;
  }
  if (resolveRuntimeAvailabilityRequest(state) != null) {
    return true;
  }
  if (
    contactCommandReadyForInjection(state)
    && contactCommandNeedsToolInjection(resolveContactCommand(state))
    && !hasPendingToolCalls(state.agentMessages)
  ) {
    return true;
  }
  const contactOwned = resolveContactIdentity(state.contactContext).kind === "owned";
  const contactWriteThisTurn =
    toolRanThisTurn(state.agentMessages ?? [], "create_contact")
    || toolRanThisTurn(state.agentMessages ?? [], "link_telegram_to_contact")
    || toolRanThisTurn(state.agentMessages ?? [], "update_contact")
    || toolRanThisTurn(state.agentMessages ?? [], "find_contact_by_phone");
  if (contactOwned && contactWriteThisTurn && createCommandFromBookingDraft(state) != null) {
    return true;
  }
  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    return toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && (
        freshAvailabilityValidatesSelectedSlot(state)
          ? !toolRanThisTurn(state.agentMessages ?? [], "reschedule_meeting")
          : true
      );
  }
  return toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
    && createCommandFromBookingDraft(state) != null;
};

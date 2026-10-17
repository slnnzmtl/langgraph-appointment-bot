import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";

import { hasPendingToolCalls, lastMessageRequestsTools } from "../tool-routing.js";
import { rewriteAiToolCalls } from "./runtime-tool-stamp.js";
import { BOOKING_AGENT_ID } from "../types.js";
import type { AvailabilitySlotsToolArgs } from "../../tools/availability-tools.js";
import { contactMissingFields } from "../../tools/contact-tools.js";
import type {
  ClinicState,
  ClinicStateUpdate,
} from "../state.js";
import {
  availabilityRequestFieldsFromDraft,
  reduceBookingDraft,
  type PendingBookingCommand,
  type BookingDraft,
  type ReplacementMeeting,
} from "../booking-draft.js";
import {
  cancelCommandForSingleVisit,
  cancelCommandFromMeeting,
  cancelCommandFromStoredPayload,
} from "../cancel-command.js";
import {
  closedBookingSessionUpdate,
  consultationService,
  interpretInteractionReply,
  openContactFieldInteraction,
  openVisitNoteInteraction,
  reduceBookingSession,
  visitMeetingChoiceLabel,
} from "../booking-session.js";
import {
  bookingOfferLabels,
  inferConversationLocaleFromText,
} from "../../shared/conversation-locale.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { availabilityRecoveryOffer } from "../booking-interaction-render.js";
import {
  contactCommandNeedsToolInjection,
  contactCommandReadyForInjection,
  resolveContactCommand,
  resolveContactIdentity,
  type ContactCommand,
} from "../contact-command.js";

import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent, extractReplyButtons, normalizeReplyLabel } from "../../shared/message-content.js";

import {
  cancelCommandFromReplacement,
  replacementActionForTurn,
} from "./replacement-flow.js";
import {
  exactRevalidateRequest,
  resolveRuntimeAvailabilityRequest,
  staleExactRevalidateRequest,
  type RuntimeAvailabilityPurpose,
} from "./availability-request.js";
import {
  MEETING_MUTATION_TOOLS,
  classifyMeetingMutationToolMessage,
  toolRanThisTurn,
  captureAvailabilityFromMessages,
  lastPatientText,
  latestMeetingMutationError,
  latestContactIncompleteMissingFields,
  type ContactIncompleteField,
} from "./protocol/index.js";
import {
  authoritativeNoteStatus,
  noteStepBlocksCreate,
} from "./booking-note-step.js";

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
  | "contact_field"
  | "consultation_agreement";

export type BookingFinalizeReason =
  | "pending_interaction"
  | "replacement_catalog"
  | "replacement_continue";

export type BookingCommandOutcome =
  | { kind: "execute"; toolCall: RuntimeToolCall; update: ClinicStateUpdate }
  | { kind: "render"; reason: BookingGuardReason; update: ClinicStateUpdate }
  | { kind: "continue_tools"; update?: ClinicStateUpdate }
  | { kind: "continue_llm"; update?: ClinicStateUpdate }
  | { kind: "finalize"; reason: BookingFinalizeReason; update?: ClinicStateUpdate };

/**
 * True when the outcome must enter command_prepare so domain updates (and
 * continue_tools tape rewrites) are applied. Conditional edges cannot write.
 * finalize never prepares — routers project it directly.
 */
export const bookingOutcomeNeedsPrepare = (
  outcome: BookingCommandOutcome,
): boolean => {
  if (outcome.kind === "finalize") {
    return false;
  }
  return outcome.kind === "execute"
    || outcome.kind === "render"
    || outcome.kind === "continue_tools"
    || outcome.update != null;
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
  if (draft == null || (draft.mode !== "create" && draft.mode !== "replace")) {
    return null;
  }
  if (draft.replacement?.status === "offered" || draft.replacement?.status === "cancelling") {
    return null;
  }
  const acceptance = draft.serviceAcceptance;
  const slot = draft.selectedSlot;
  if (
    draft.replacement?.status === "create_pending"
    && draft.replacement.originalCommand?.action === "create"
  ) {
    const payload = draft.replacement.originalCommand.payload;
    const frozenMatchesCanonical = acceptance?.status === "accepted"
      && slot != null
      && (draft.note.status === "skipped" || draft.note.status === "answered")
      && payload.serviceId === acceptance.service.id
      && payload.contactId === draft.contactId
      && payload.dateStart === slot.dateStart
      && payload.dateEnd === slot.dateEnd;
    if (frozenMatchesCanonical) {
      return { ...draft.replacement.originalCommand };
    }
    // Mismatched frozen create must not execute; fall through and derive.
  }
  const contactIdentity = resolveContactIdentity(state.contactContext, draft.contactId);
  if (
    acceptance?.status !== "accepted"
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

/** Domain-only execute outcome — stamp/telemetry happen in command mapping. */
const executeToolOutcome = (
  toolCall: RuntimeToolCall,
  update: ClinicStateUpdate = {},
): BookingCommandOutcome => ({
  kind: "execute",
  toolCall,
  update,
});

const messagesForContinue = (
  state: ClinicState,
  update?: ClinicStateUpdate,
): BaseMessage[] => {
  if (update?.agentMessages == null) {
    return state.agentMessages ?? [];
  }
  const agentMessages = update.agentMessages;
  if (agentMessages instanceof Overwrite) {
    return agentMessages.value;
  }
  return Array.isArray(agentMessages) ? agentMessages : state.agentMessages ?? [];
};

const lastAiWithToolCalls = (
  messages: BaseMessage[],
): { index: number; message: AIMessage } | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
      return { index, message };
    }
  }
  return null;
};

/**
 * Former `none`: pick continue_tools vs continue_llm from effective tape.
 * Pending mutation calls during unresolved HITL (non-rearm) → continue_llm so
 * routers finalize model prose instead of re-entering command_prepare/tools.
 */
const continueWithoutCommand = (
  state: ClinicState,
  update?: ClinicStateUpdate,
): BookingCommandOutcome => {
  const messages = messagesForContinue(state, update);
  const pending =
    hasPendingToolCalls(messages) || lastMessageRequestsTools(messages);
  if (pending) {
    if (
      hasMutationCallDuringUnresolvedConfirmation(state)
      && !shouldRearmCancelAfterChatOther(state)
    ) {
      const lastAi = lastAiWithToolCalls(messages);
      const calls = lastAi?.message.tool_calls ?? [];
      const informationalOnly = calls.length > 0
        && calls.every((call) => commandActionForTool(call.name) == null);
      if (!informationalOnly) {
        return update != null
          ? { kind: "continue_llm", update }
          : { kind: "continue_llm" };
      }
    }
    return update != null
      ? { kind: "continue_tools", update }
      : { kind: "continue_tools" };
  }
  return update != null
    ? { kind: "continue_llm", update }
    : { kind: "continue_llm" };
};

const availabilityExecute = (
  args: AvailabilitySlotsToolArgs,
  purpose: RuntimeAvailabilityPurpose,
  toolCallId: string,
  update: ClinicStateUpdate = {},
): BookingCommandOutcome =>
  executeToolOutcome(
    {
      id: toolCallId,
      name: "present_availability_slots",
      args: args as Record<string, unknown>,
      action: purpose,
    },
    update,
  );

/** Overlay CRM missingFields onto cached contactContext so ContactCommand agrees with the mutation error. */
const overlayContactIncompleteFields = (
  context: ClinicState["contactContext"],
  contactId: string | null | undefined,
  missingFields: readonly ContactIncompleteField[],
): ClinicState["contactContext"] => {
  if (context == null || contactId == null || missingFields.length === 0) {
    return context;
  }
  return {
    ...context,
    contacts: context.contacts.map((contact) => {
      if (contact.id !== contactId) {
        return contact;
      }
      const next: Record<string, unknown> = {
        ...contact,
        missingFields: [...missingFields],
      };
      for (const field of missingFields) {
        next[field] = null;
      }
      return next;
    }),
  };
};

/**
 * After create_meeting returns Contact incomplete: trust CRM missingFields,
 * drop the HITL confirm card, and open contact_field (create) or clear confirm (reschedule).
 * Does not re-run ContactCommand — CRM is the source of truth for incomplete.
 */
const contactIncompleteRecovery = (state: ClinicState): BookingCommandOutcome => {
  const missingFromCrm = latestContactIncompleteMissingFields(state.agentMessages ?? [])
    ?? [];
  const clearedConfirm = reduceBookingSession(
    {
      bookingDraft: state.bookingDraft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "mutation_confirm_cleared" },
  );
  let bookingDraft = clearedConfirm.bookingDraft;
  if (bookingDraft?.pendingCommand != null) {
    bookingDraft = reduceBookingDraft(bookingDraft, { type: "command_cleared" });
  }
  const contactContext = overlayContactIncompleteFields(
    state.contactContext,
    bookingDraft?.contactId,
    missingFromCrm,
  );

  const baseUpdate: ClinicStateUpdate = {
    bookingDraft,
    pendingInteraction: clearedConfirm.pendingInteraction,
    ...(contactContext !== state.contactContext ? { contactContext } : {}),
  };

  // Reschedule never collects contact fields; still drop the phantom confirm card.
  if (bookingDraft?.mode === "reschedule") {
    return { kind: "render", reason: "contact_field", update: baseUpdate };
  }

  const field = missingFromCrm[0];
  if (field != null) {
    return {
      kind: "render",
      reason: "contact_field",
      update: {
        ...baseUpdate,
        pendingInteraction: openContactFieldInteraction(field),
      },
    };
  }

  // Never leave mutation_confirm active after Contact incomplete.
  return { kind: "render", reason: "contact_field", update: baseUpdate };
};

const STALE_REVALIDATE_TOOL_CALL_PREFIX = "booking_stale_revalidate_";

const staleRevalidateRanThisTurn = (messages: BaseMessage[]): boolean =>
  messages.some(
    (message) =>
      message instanceof ToolMessage
      && message.name === "present_availability_slots"
      && typeof message.tool_call_id === "string"
      && message.tool_call_id.startsWith(STALE_REVALIDATE_TOOL_CALL_PREFIX),
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
  // Only recover DATE/TIME from this-turn present_availability_slots. An error
  // payload cannot be normalized; falling back to checkpoint would reoffer the
  // slot we just failed to revalidate.
  const captured = captureAvailabilityFromMessages(state.agentMessages ?? []) ?? null;
  const recoveryState: ClinicState = {
    ...state,
    bookingDraft: session.bookingDraft,
    pendingInteraction: session.pendingInteraction,
    availabilityContext: captured,
  };
  const offer = captured != null ? availabilityRecoveryOffer(recoveryState) : null;
  if (offer != null) {
    return {
      kind: "render",
      reason: "stale_slot",
      update: {
        bookingDraft: session.bookingDraft,
        pendingInteraction: offer.interaction,
        ...(captured !== state.availabilityContext
          ? { availabilityContext: captured }
          : {}),
      },
    };
  }

  const dropStaleSnapshot = {
    bookingDraft: session.bookingDraft,
    pendingInteraction: session.pendingInteraction,
    availabilityContext: null,
    availabilityCursor: null,
  };

  // At most one ungated stale force-refresh per turn.
  if (staleRevalidateRanThisTurn(state.agentMessages ?? [])) {
    return {
      kind: "render",
      reason: "missing_exact_date",
      update: dropStaleSnapshot,
    };
  }

  const purpose = state.bookingDraft?.mode === "reschedule"
    ? "reschedule_revalidate"
    : "create_revalidate";
  const revalidate = staleExactRevalidateRequest(
    { ...state, bookingDraft: session.bookingDraft },
    purpose,
  );
  if (revalidate != null) {
    return availabilityExecute(
      revalidate.args,
      revalidate.purpose,
      `${STALE_REVALIDATE_TOOL_CALL_PREFIX}${state.bookingDraft?.version ?? 0}`,
      dropStaleSnapshot,
    );
  }

  return {
    kind: "render",
    reason: "missing_exact_date",
    update: dropStaleSnapshot,
  };
};

/** True when create/reschedule targets consultation without an accepted agreement. */
const consultationAgreementRequired = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  if (draft == null) {
    return false;
  }
  // Card already open: prepare-produced turns finalize via bookingSkipLlm;
  // unmatched prose must reach the booking LLM, not reprint the same question.
  if (
    state.pendingInteraction?.kind === "service_confirm"
    && state.pendingInteraction.service.id === CONSULTATION_SERVICE_ID
  ) {
    return false;
  }
  const acceptance = draft.serviceAcceptance;
  const pendingServiceId =
    typeof draft.pendingCommand?.payload?.serviceId === "string"
      ? draft.pendingCommand.payload.serviceId
      : null;
  const targetsConsultation =
    pendingServiceId === CONSULTATION_SERVICE_ID
    || acceptance?.service.id === CONSULTATION_SERVICE_ID;
  if (!targetsConsultation) {
    return false;
  }
  return !(
    acceptance?.status === "accepted"
    && acceptance.service.id === CONSULTATION_SERVICE_ID
  );
};

const consultationAgreementRender = (state: ClinicState): BookingCommandOutcome => {
  const draft = state.bookingDraft;
  const labels = bookingOfferLabels(
    inferConversationLocaleFromText(lastPatientText(state)),
  );
  const session = reduceBookingSession(
    {
      bookingDraft: draft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    {
      type: "service_offered",
      service: consultationService("catalog"),
      acceptLabel: labels.acceptLabel,
      chooseOtherLabel: labels.chooseOtherLabel,
    },
  );
  return {
    kind: "render",
    reason: "consultation_agreement",
    update: {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
    },
  };
};

/**
 * Already-open contact_field / prepare-produced service_confirm ship via finalize —
 * do not bounce through command_prepare to re-render the same card.
 * Unmatched prose on an existing confirm must reach the booking LLM
 * (`bookingSkipLlm` false) — never reprint from contact ownership alone.
 */
const openPendingInteractionFinalize = (
  state: ClinicState,
): BookingCommandOutcome | null => {
  if (state.pendingInteraction?.kind === "contact_field") {
    return { kind: "finalize", reason: "pending_interaction" };
  }
  if (
    state.bookingSkipLlm
    && state.pendingInteraction?.kind === "service_confirm"
    && state.bookingDraft?.serviceAcceptance?.status === "pending"
  ) {
    return { kind: "finalize", reason: "pending_interaction" };
  }
  return null;
};

/**
 * After REPLACE cancel_meeting this turn: leave the booking tools loop.
 * No accepted service → FAQ catalog handoff; otherwise continue booking UI.
 */
const replacementCancelFinalize = (
  state: ClinicState,
): BookingCommandOutcome | null => {
  if (
    state.pendingCancellationPurpose !== "replacement"
    || state.bookingDraft?.mode !== "create"
    || state.bookingDraft.replacement != null
    || !toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")
  ) {
    return null;
  }
  if (state.bookingDraft.serviceAcceptance?.status !== "accepted") {
    return { kind: "finalize", reason: "replacement_catalog" };
  }
  if (
    state.pendingInteraction?.kind === "service_confirm"
    || (
      state.pendingInteraction?.kind === "service_candidate"
      && state.pendingInteraction.owner === "faq"
    )
    || toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
  ) {
    return { kind: "finalize", reason: "replacement_continue" };
  }
  return null;
};

/**
 * Pure booking transition: availability, contact, mutations, finalize, or a
 * renderable guard. Does not write a durable outcome onto checkpoint state.
 */
export const resolveBookingCommand = (state: ClinicState): BookingCommandOutcome => {
  if (hasPendingConfirmationChatOther(state)) {
    if (!shouldRearmCancelAfterChatOther(state)) {
      return continueWithoutCommand(state);
    }
    const messages = state.agentMessages ?? [];
    const lastAiEntry = lastAiWithToolCalls(messages);
    const pendingCalls = lastAiEntry?.message.tool_calls ?? [];
    const nonMutationCalls = pendingCalls.filter(
      (call) => commandActionForTool(call.name) == null,
    );
    if (
      nonMutationCalls.length > 0
      && (hasPendingToolCalls(messages) || lastMessageRequestsTools(messages))
    ) {
      if (nonMutationCalls.length === pendingCalls.length) {
        return continueWithoutCommand(state);
      }
      return continueWithoutCommand(state, {
        agentMessages: new Overwrite(
          rewriteAiToolCalls(messages, lastAiEntry!.index, nonMutationCalls),
        ),
      });
    }
    const rearmCancel = cancelCommandFromPlannedVisit(state);
    if (rearmCancel == null) {
      return continueWithoutCommand(state);
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
    return executeToolOutcome(toolCall, prepared);
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
    return continueWithoutCommand(state, {
      ...closedBookingSessionUpdate(),
      agentMessages: new Overwrite([]),
    });
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
    return continueWithoutCommand(state);
  }

  const openInteraction = openPendingInteractionFinalize(state);
  if (openInteraction != null) {
    return openInteraction;
  }

  // Consultation agreement before contact / availability mutation so an
  // unaccepted consultation never collects identity or retries create.
  if (consultationAgreementRequired(state)) {
    return consultationAgreementRender(state);
  }

  // Availability before contact so service-change / date intent can refresh
  // slots without blocking on the identity ladder.
  const availability = resolveRuntimeAvailabilityRequest(state);
  if (availability != null) {
    return availabilityExecute(
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
        return executeToolOutcome(toolCall);
      }
    }
  }

  if (createBlockedOnlyByNote(state)) {
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

  // CRM Contact incomplete: reopen the identity ladder; do not retry create.
  if (latestMeetingMutationError(state.agentMessages ?? []) === "Contact incomplete") {
    return contactIncompleteRecovery(state);
  }

  const rescheduleCommand = rescheduleCommandFromBookingDraft(state);
  if (rescheduleCommand != null) {
    if (!toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")) {
      const revalidate = exactRevalidateRequest(state, "reschedule_revalidate");
      if (revalidate == null) {
        return { kind: "render", reason: "missing_exact_date", update: {} };
      }
      return availabilityExecute(
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

  const replacementFinalize = replacementCancelFinalize(state);
  if (replacementFinalize != null) {
    return replacementFinalize;
  }

  return continueWithoutCommand(state);
};

/**
 * True when model prose must not ship: a non-committed meeting write this turn,
 * draft past slot selection (details/confirming), or an open ✅/❌ confirm.
 * Service/date/time/note stay covered by schedule reselect and interaction render.
 */
export const bookingOutcomeRiskState = (state: ClinicState): boolean => {
  const messages = state.agentMessages ?? [];
  for (const message of messages) {
    if (!(message instanceof ToolMessage)) {
      continue;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    if (
      outcome === "failed"
      || outcome === "blocked"
      || outcome === "declined"
      || outcome === "abandoned"
      || outcome === "pending_confirmation"
    ) {
      return true;
    }
  }
  const draft = state.bookingDraft;
  if (draft != null) {
    // Uncommitted `ready` is waiting for command_prepare HITL — model prose must not ship.
    if (
      draft.phase === "details"
      || draft.phase === "confirming"
      || draft.phase === "ready"
      || draft.pendingCommand != null
    ) {
      return true;
    }
  }
  return state.pendingInteraction?.kind === "mutation_confirm";
};

/**
 * A direct move from «Мій запис» has one authoritative target. Keep the
 * availability query tied to that target so its current slot is not offered
 * again and a model-generated DATE prompt cannot bypass the lookup.
 */
export const rescheduleAvailabilityArgsFromBookingContext = (
  state: ClinicState,
  args: Record<string, unknown> = {},
): Record<string, unknown> | null => {
  const meeting = state.bookingDraft?.mode === "reschedule"
    ? state.bookingDraft.rescheduleTarget
    : null;
  if (!meeting) {
    return null;
  }
  return {
    ...args,
    direction: args.direction ?? "nearest",
    ...availabilityRequestFieldsFromDraft(state.bookingDraft),
  };
};

/**
 * Fill a missing reschedule target. Prefer a single listed meeting, then an
 * open visit_select chip / ordinal against that picker — never name substring.
 */
export const rescheduleTargetFromBookingContext = (
  state: ClinicState,
): ReplacementMeeting | null => {
  const existing = state.bookingDraft?.mode === "reschedule"
    ? state.bookingDraft.rescheduleTarget
    : null;
  if (existing) return existing;
  const meetings = state.bookingContext?.meetings ?? [];
  if (meetings.length === 1) return meetings[0] ?? null;
  if (meetings.length === 0) return null;

  const human = lastPatientText(state).trim();
  const interaction = state.pendingInteraction;
  if (
    interaction?.kind === "visit_select"
    && (interaction.stage === "meeting" || interaction.stage === "action")
  ) {
    const match = interpretInteractionReply(interaction, human);
    if (match.kind === "choice") {
      const byId = meetings.find((meeting) => meeting.id === match.choiceId);
      if (byId != null) {
        return byId;
      }
    }
  }
  const ordinal = /^(\d+)$/.exec(human);
  if (ordinal && Number(ordinal[1]) <= meetings.length) {
    return meetings[Number(ordinal[1]) - 1] ?? null;
  }
  // Unique exact rendered meeting label (same as visit picker chips).
  const normalized = normalizeReplyLabel(human);
  const exactLabel = meetings.filter((meeting) => {
    const chip = normalizeReplyLabel(visitMeetingChoiceLabel(meeting));
    const name = normalizeReplyLabel(meeting.name ?? "");
    return chip === normalized || (name.length > 0 && name === normalized);
  });
  return exactLabel.length === 1 ? exactLabel[0]! : null;
};

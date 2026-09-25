import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import {
  createCachedGeminiModel,
  isCachedContentNotFoundError,
  type ContextCacheHandle,
} from "@personal-assistant/llm-gemini";

import { stripToolNoiseFromMessages } from "./supervisor-history.js";
import type { SupervisorContextCacheOptions } from "./supervisor.js";
import { hasPendingToolCalls, lastMessageRequestsTools } from "./tool-routing.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type BookingNoteStatus,
  type ClinicAgentDefinition,
  type ClinicHandoffStatus,
  type SelectedBookingSlot,
} from "./types.js";
import {
  normalizePresentAvailabilityResult,
  alignToAnchors,
  availabilityCursorFromContext,
  tryAvailabilityCacheHit,
  KYIV_LOCAL_ISO_SCHEMA,
  presentAvailabilitySlotsArgsSchema,
  type AvailabilityContext,
  type AvailabilitySlotsToolArgs,
} from "../tools/availability-tools.js";
import { normalizeAvailabilityToolArgs } from "../tools/availability-args.js";
import {
  formatKyivDayLabel,
  kyivToday,
  normalizeLocalIsoDatetime,
  shortDayMonthLabel,
} from "../tools/availability-slots.js";
import { resolveAvailabilityRequest } from "../tools/availability-request.js";
import { normalizeContactLookupResult } from "../tools/contact-tools.js";
import {
  normalizeListServicesResult,
  type ServicesContext,
} from "../tools/service-tools.js";
import type { BookingContext } from "../tools/planned-meetings.js";
import { trackEvent, trackToolError } from "../analytics/track.js";
import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  CONSULTATION_SERVICE_ID,
  CLINIC_SLOT_MINUTES,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  EARLIER_DATE_LABEL,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  LATER_DATE_LABEL,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  PATIENT_FALLBACK_MESSAGE,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
  defaultMenuLabels,
} from "../shared/clinic-constants.js";
import { asJsonRecord } from "../shared/json-record.js";
import {
  catalogChoiceButtonsFromText,
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
  isBookingOfferQuestion,
  isConsultationOfferQuestion,
  isYesReply,
  parseLeakedModelToolCalls,
  requestsConsultation,
  stripLeakedModelToolCalls,
} from "../shared/message-content.js";
import { normalizeClinicPhone } from "../shared/phone.js";
import {
  formatBookingMeetingsContext,
  formatBookingDraftContext,
  formatContactContext,
  formatPlannedVisitsFlag,
  formatServicesContext,
} from "./context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import type { CancellationPurpose, ClinicState, ClinicStateUpdate } from "./state.js";
import {
  reduceBookingDraft,
  type PendingBookingCommand,
  type BookingDraft,
  type BookingService,
  type ReplacementMeeting,
} from "./booking-draft.js";
import {
  isModelFailureMessage,
  tagModelFailureMessage,
  tagRuntimeAgentMessage,
} from "./sub-agent-messages.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;
export const commandPrepareNodeName = (agentId: string): string => `${agentId}__command_prepare`;
export const llmNodeName = (agentId: string): string => `${agentId}__llm`;
export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;
export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;
export const mutationFinalizeNodeName = (agentId: string): string => `${agentId}__mutation_finalize`;

export type CreateAgentLoopOptions = {
  agent: ClinicAgentDefinition;
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  formatSystemMetadata: (date: Date, options?: { runtimeAgent?: string }) => string;
  contextCache?: SupervisorContextCacheOptions;
};

/** CRM writes that invalidate checkpointed contact/meetings prefetch. */
const PREFETCH_INVALIDATING_TOOLS = new Set([
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

const MEETING_MUTATION_TOOLS = new Set([
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

const CREATE_CONSULTATION_REQUIRED_ERROR = "Consultation agreement required";
const SLOT_SELECTION_REQUIRED_ERROR = "Availability slot selection required";
const SELECTED_SLOT_NOT_AVAILABLE_ERROR = "Selected slot is no longer available";

const CONSULTATION_AGREEMENT_TOOLS = new Set(["create_meeting", "reschedule_meeting"]);

const toolCallServiceId = (call: { args?: unknown }): string | null => {
  const args = call.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const serviceId = (args as { serviceId?: unknown }).serviceId;
  return typeof serviceId === "string" ? serviceId : null;
};

const blocksConsultationWithoutAgreement = (
  agentId: string | undefined,
  call: { name: string; args?: unknown },
  state: ClinicState,
): boolean =>
  agentId === BOOKING_AGENT_ID
  && CONSULTATION_AGREEMENT_TOOLS.has(call.name)
  && toolCallServiceId(call) === CONSULTATION_SERVICE_ID
  && !(
    state.bookingDraft?.serviceAcceptance?.status === "accepted"
    && state.bookingDraft.serviceAcceptance.service.id === CONSULTATION_SERVICE_ID
  );

const BLOCKED_MEETING_ERRORS = new Set([
  "Contact incomplete",
  "Already booked",
  "Not authorized",
  "Note step required",
  CREATE_CONSULTATION_REQUIRED_ERROR,
  SLOT_SELECTION_REQUIRED_ERROR,
  SELECTED_SLOT_NOT_AVAILABLE_ERROR,
]);

export type MeetingMutationOutcome =
  | "committed"
  | "pending_confirmation"
  | "declined"
  | "blocked"
  | "failed"
  | null;

export const classifyMeetingMutationToolMessage = (
  message: ToolMessage,
): MeetingMutationOutcome => {
  const name = message.name;
  if (!name || !MEETING_MUTATION_TOOLS.has(name)) {
    return null;
  }
  const body = extractMessageTextContent(message.content).trim();
  if (body.startsWith("Error:")) {
    return "failed";
  }
  const record = asJsonRecord(body);
  if (!record) {
    return "committed";
  }
  if (record.awaitingConfirmation === true) {
    return "pending_confirmation";
  }
  if (record.cancelled === true) {
    return "declined";
  }
  if (typeof record.error === "string") {
    return BLOCKED_MEETING_ERRORS.has(record.error) ? "blocked" : "failed";
  }
  return "committed";
};

const meetingMutationIsHitlDecline = (message: ToolMessage): boolean =>
  MEETING_MUTATION_TOOLS.has(message.name ?? "")
  && asJsonRecord(extractMessageTextContent(message.content).trim())?.cancelled === true;

const terminalCancellationOutcome = (state: ClinicState): ToolMessage | null => {
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof ToolMessage) || message.name !== "cancel_meeting") {
      continue;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    // A committed replacement cancellation is a continuation, not a
    // patient-facing terminal outcome: the replacement create flow owns it.
    // Declined/failed replacement cancellation outcomes are terminal, but must
    // retain their replacement origin for the correct response/menu.
    if (state.pendingCancellationPurpose === "replacement") {
      return outcome === "declined" || outcome === "failed" ? message : null;
    }
    // Keep the legacy state guard for checkpoints created before the explicit
    // cancellation-purpose field existed.
    if (state.bookingDraft?.replacement != null) {
      return null;
    }
    if (outcome === "committed" || outcome === "declined" || outcome === "failed") {
      return message;
    }
    return null;
  }
  return null;
};

/** Committed, failed, or HITL ❌ — stale free/busy and note step must not survive. */
export const meetingMutationClearsAvailability = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    return outcome === "committed" || outcome === "failed" || meetingMutationIsHitlDecline(message);
  });

const toolMessageName = (message: BaseMessage): string | undefined => {
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
};

/** True when a ToolMessage for this tool is already in the current agent turn. */
const toolRanThisTurn = (messages: BaseMessage[], toolName: string): boolean =>
  messages.some(
    (message) => message instanceof ToolMessage && toolMessageName(message) === toolName,
  );

export const captureLatestToolContext = <T>(
  messages: BaseMessage[],
  toolName: string,
  normalize: (raw: string) => T | null,
): T | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || toolMessageName(message) !== toolName) {
      continue;
    }
    return normalize(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
};

export const captureAvailabilityFromMessages = (
  messages: BaseMessage[],
): AvailabilityContext | null | undefined =>
  captureLatestToolContext(messages, "present_availability_slots", normalizePresentAvailabilityResult);

export const captureServicesFromMessages = (
  messages: BaseMessage[],
): ServicesContext | null | undefined =>
  captureLatestToolContext(messages, "list_services", normalizeListServicesResult);

const AVAILABILITY_DATE_HEADING = "Найближчі вільні дні";
const AVAILABILITY_GENERIC_DATE_HEADING = "Доступні дні";
const AVAILABILITY_TIME_HEADING = "Вільні години на ";

const availabilityHeadingAnchor = (context: AvailabilityContext): string | undefined => {
  const query = context.query;
  if (query?.kind === "later" || query?.kind === "earlier") {
    return query.anchor ?? context.searchAnchor;
  }
  return undefined;
};

/** Heading for a DATE page, derived from the runtime-owned search query. */
export const formatAvailabilityHeading = (context: AvailabilityContext): string => {
  const kind = context.query?.kind ?? context.searchDirection;
  if (kind === "nearest") {
    return AVAILABILITY_DATE_HEADING;
  }
  const anchor = availabilityHeadingAnchor(context);
  if (kind === "later" && anchor) {
    return `Вільні дні після ${shortDayMonthLabel(formatKyivDayLabel(anchor, kyivToday()))}`;
  }
  if (kind === "earlier" && anchor) {
    return `Вільні дні до ${shortDayMonthLabel(formatKyivDayLabel(anchor, kyivToday()))}`;
  }
  return AVAILABILITY_GENERIC_DATE_HEADING;
};

/** DATE offer from a multi-day availability snapshot (code-owned when the model invents hours). */
export const formatAvailabilityDateOffer = (
  contextOrDays: AvailabilityContext | AvailabilityContext["days"],
): { replyText: string; replyButtons: string[] } => {
  const context: AvailabilityContext = Array.isArray(contextOrDays)
    ? { days: contextOrDays, stepMinutes: CLINIC_SLOT_MINUTES }
    : contextOrDays;
  const { days } = context;
  const open = days.filter((day) => day.slots.length > 0).slice(0, 3);
  const bullets = open
    .map((day) => {
      const dayPart = day.dayLabel ?? day.date;
      const hours = day.slots.map((slot) => slot.label).join(", ");
      return `  - ${dayPart}: ${hours}`;
    })
    .join("\n");
  return {
    replyText: `${formatAvailabilityHeading(context)} 🗓️\n\n${bullets}\n\nЯкий день вам зручний?`,
    replyButtons: [
      ...open.map((day) => shortDayMonthLabel(day.dayLabel ?? day.date)),
      OTHER_DATE_LABEL,
    ],
  };
};

/** TIME offer from a single-day availability snapshot. */
export const formatAvailabilityTimeOffer = (
  day: AvailabilityContext["days"][number],
): { replyText: string; replyButtons: string[] } => {
  const dayLabel = day.dayLabel ?? day.date;
  const labels = day.slots.map((slot) => slot.label);
  const bullets = labels.map((label) => `  - ${label}`).join("\n");
  return {
    replyText: `${AVAILABILITY_TIME_HEADING}${dayLabel} 🗓️\n\n${bullets}\n\nЯкий час вам зручний?`,
    replyButtons: [...labels.slice(0, 3), OTHER_DATE_LABEL],
  };
};

export const formatAvailabilityEmptyOffer = (
  context: AvailabilityContext,
): { replyText: string; replyButtons: string[] } => {
  const direction = context.searchDirection;
  const anchor = context.searchAnchor ?? context.searchedFrom ?? context.days[0]?.date;
  const canSearchEarlier =
    direction !== "earlier"
    && anchor != null
    && anchor > kyivToday();

  if (direction === "earlier") {
    return {
      replyText: "Раніших вільних дат не знайшли. Пошукати пізніші дати?",
      replyButtons: [LATER_DATE_LABEL],
    };
  }

  if (direction === "exact") {
    return {
      replyText: "На цю дату вільного часу немає. Пошукати іншу дату?",
      replyButtons: [
        ...(canSearchEarlier ? [EARLIER_DATE_LABEL] : []),
        LATER_DATE_LABEL,
      ],
    };
  }

  return {
    replyText: "У цьому періоді вільного часу немає. Пошукати інші дати?",
    replyButtons: [
      ...(canSearchEarlier ? [EARLIER_DATE_LABEL] : []),
      LATER_DATE_LABEL,
    ],
  };
};

const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

const lastPatientText = (state: ClinicState): string =>
  lastHumanText(state.messages) || lastHumanText(state.agentMessages ?? []);

/**
 * A consultation offer is an explicit pending conversation action. An affirmative
 * answer starts the DATE step from today, even when an older exact-date snapshot
 * is still checkpointed. It must not inherit that snapshot's pagination cursor.
 */
export const isConsultationOfferAcceptance = (state: ClinicState): boolean => {
  const handoff = state.lastHandoff;
  return (
    (handoff?.agentId === BOOKING_AGENT_ID || handoff?.agentId === FAQ_AGENT_ID)
    && handoff.status === "ok"
    && isConsultationOfferQuestion(handoff.replyText ?? "")
    && isYesReply(lastPatientText(state))
  );
};

/** Known keyboard labels that must not collide with an «Інша дата» prefix tap. */
const OTHER_DATE_COLLISION_LABELS = [
  MAIN_MENU_LABEL,
  ...DEFAULT_MENU_NO_VISITS,
  ...DEFAULT_MENU_HAS_VISITS,
  ...BOOKING_OFFER_MENU,
  ...BOOKING_OFFER_MENU_EN,
  ...BOOKING_REPLACE_MENU,
  ...BOOKING_REPLACE_MENU_EN,
  ...VISIT_CHANGE_MENU,
  ...VISIT_CHANGE_MENU_EN,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  "Book",
  "Services",
  "Address",
  "My visit",
].map((label) => label.toLowerCase());

const RUSSIAN_OTHER_DATE_RE =
  /^(?:другая|другой|другую|другие)(?:\s+(?:дата|дату|даты|день|дни|вариант(?:ы)?))?$/i;

/**
 * Exact Ukrainian/English keyboard label, its unique prefix (≥4 chars, e.g. «Інша»),
 * or a standalone Russian equivalent (e.g. «другая», «другой»).
 * Rejects a prefix that also prefixes another known keyboard label.
 */
const isOtherDateHuman = (humanText: string): boolean => {
  const normalized = humanText.trim().toLowerCase();
  if (normalized.length < 4) {
    return false;
  }
  if (RUSSIAN_OTHER_DATE_RE.test(normalized)) {
    return true;
  }
  const targets = [OTHER_DATE_LABEL, OTHER_DATE_LABEL_EN].map((label) => label.toLowerCase());
  const matched = targets.find(
    (target) => normalized === target || target.startsWith(normalized),
  );
  if (!matched) {
    return false;
  }
  if (normalized === matched) {
    return true;
  }
  return !OTHER_DATE_COLLISION_LABELS.some(
    (label) => label.startsWith(normalized) && !targets.includes(label),
  );
};

const bookingDateAnchors = (state: ClinicState): string[] => [
  ...(state.bookingDraft?.selectedDate ? [state.bookingDraft.selectedDate] : []),
  ...(state.bookingDraft?.selectedSlot
    ? [state.bookingDraft.selectedSlot.dateStart, state.bookingDraft.selectedSlot.dateEnd]
    : []),
  ...(state.bookingDraft == null && state.selectedAvailabilityDate
    ? [state.selectedAvailabilityDate]
    : []),
  ...(state.bookingDraft == null && state.selectedSlot
    ? [state.selectedSlot.dateStart, state.selectedSlot.dateEnd]
    : []),
  ...(state.availabilityContext?.days ?? []).map((day) => day.date),
  ...(state.availabilityCursor
    ? [
      state.availabilityCursor.firstDate,
      state.availabilityCursor.lastDate,
      state.availabilityCursor.searchedFrom,
      state.availabilityCursor.searchedThrough,
    ].filter((date): date is string => date != null)
    : []),
];

const authoritativeSelectedSlot = (state: ClinicState): SelectedBookingSlot | null =>
  state.bookingDraft != null ? state.bookingDraft.selectedSlot : state.selectedSlot;

const authoritativeNoteStatus = (state: ClinicState): BookingNoteStatus =>
  state.bookingDraft?.note.status ?? state.bookingNoteStatus ?? "unasked";

/** Stable identity for the exact availability snapshot used by a slot selection. */
export const availabilitySnapshotId = (context: AvailabilityContext): string => {
  const payload = JSON.stringify({
    days: context.days,
    stepMinutes: context.stepMinutes,
    serviceId: context.serviceId ?? null,
    excludeMeetingIds: context.excludeMeetingIds ?? [],
    query: context.query ?? null,
  });
  // FNV-1a is sufficient here: this is an equality/version key, not a security hash.
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `availability-${(hash >>> 0).toString(16)}`;
};

const consultationService = (source: "catalog" | "direct"): {
  id: string;
  name: string;
  source: "catalog" | "direct";
} => ({
  id: CONSULTATION_SERVICE_ID,
  name: "Консультація",
  source,
});

const catalogServiceForText = (
  text: string,
  state: ClinicState,
): { id: string; name: string; durationMinutes?: number; source: "catalog" } | null => {
  const normalized = text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.includes("?")) {
    return null;
  }
  const service = state.servicesContext?.list.find((candidate) => {
    const name = candidate.name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    return normalized === name || normalized.includes(name) || name.includes(normalized);
  });
  if (!service) {
    return null;
  }
  return {
    id: service.id,
    name: service.name,
    ...(service.duration != null ? { durationMinutes: service.duration } : {}),
    source: "catalog",
  };
};

const mentionsConsultationSelection = (text: string): boolean =>
  /консультац|consultation/i.test(text)
  && !text.includes("?")
  && !/\b(?:не|без|not|don't|no)\b/i.test(text);

/** Resolve explicit service acceptance into a durable draft event for this turn. */
const bookingDraftForTurn = (state: ClinicState): BookingDraft | undefined => {
  const humanMessages = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  const current = humanMessages.at(-1);
  if (!current) {
    return undefined;
  }
  const currentText = extractMessageTextContent(current.content).trim();
  const previousText = humanMessages.at(-2)
    ? extractMessageTextContent(humanMessages.at(-2)!.content).trim()
    : "";
  const latestAssistantText = [...(state.messages ?? [])]
    .reverse()
    .find((message) => message instanceof AIMessage);
  const handoffQuestion = state.lastHandoff?.replyText
    ?? (latestAssistantText ? extractMessageTextContent(latestAssistantText.content) : "");
  const consultationOffer = isConsultationOfferQuestion(handoffQuestion);
  const selectedCatalogServiceBeforeYes = catalogServiceForText(previousText, state);
  const selectedConsultationBeforeYes =
    selectedCatalogServiceBeforeYes != null || mentionsConsultationSelection(previousText);
  const directCatalogService = catalogServiceForText(currentText, state);
  const directRequest = requestsConsultation(currentText);
  const affirmativeConsultation =
    isYesReply(currentText) && (consultationOffer || selectedConsultationBeforeYes);
  const pendingService = state.bookingDraft?.serviceAcceptance;
  const isAvailabilityContinuation =
    resolveAvailabilityRequest(currentText, kyivToday()) != null
    || /\b\d{1,2}(?::\d{2})?\b/.test(currentText);

  if (directRequest) {
    return reduceBookingDraft(state.bookingDraft, {
      type: "service_selected",
      service: consultationService("direct"),
      accepted: true,
      turn: state.stepCount,
    });
  }
  if (
    directCatalogService
    && /(?:запиш\w*|записат\w*|хочу|бажаю|потрібн\w*|треба|book|want|need)/i.test(currentText)
  ) {
    return reduceBookingDraft(state.bookingDraft, {
      type: "service_selected",
      service: directCatalogService,
      accepted: true,
      turn: state.stepCount,
    });
  }
  // A dated request immediately after the consultation offer is an affirmative
  // booking action, even when the patient did not tap «Так».
  if (pendingService?.status === "pending" && isAvailabilityContinuation) {
    return reduceBookingDraft(state.bookingDraft, {
      type: "service_accepted",
      turn: state.stepCount,
    });
  }
  if (!affirmativeConsultation) {
    return undefined;
  }
  if (
    state.bookingDraft?.serviceAcceptance?.status === "pending"
    && state.bookingDraft.serviceAcceptance.service.id === CONSULTATION_SERVICE_ID
  ) {
    return reduceBookingDraft(state.bookingDraft, {
      type: "service_accepted",
      turn: state.stepCount,
    });
  }
  return reduceBookingDraft(state.bookingDraft, {
    type: "service_selected",
    service: selectedCatalogServiceBeforeYes ?? consultationService("catalog"),
    accepted: true,
    turn: state.stepCount,
  });
};

/** Seed the pending service when a specialist emits a booking offer. */
const offeredServiceForReply = (
  state: ClinicState,
  replyText: string,
): BookingService | null => {
  if (!isBookingOfferQuestion(replyText)) {
    return null;
  }
  if (isConsultationOfferQuestion(replyText)) {
    return consultationService("catalog");
  }
  const humanMessages = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  for (let index = humanMessages.length - 1; index >= 0; index -= 1) {
    const service = catalogServiceForText(
      extractMessageTextContent(humanMessages[index]!.content),
      state,
    );
    if (service) {
      return service;
    }
  }
  return null;
};

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
const normalizeMeetingMutationArgs = (
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
  const ownedContactId = state.contactContext?.contacts.find(
    (contact) => typeof contact.id === "string" && contact.id.length > 0,
  )?.id;
  if (call.name === "create_meeting" && typeof ownedContactId === "string") {
    args.contactId = ownedContactId;
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

const commandIdempotencyKey = (
  action: "create" | "reschedule" | "replace" | "cancel",
  payload: Record<string, unknown>,
): string => action + ":" + JSON.stringify(payload);

const DIRECT_CANCEL_INTENT = /^(?:скасувати|скасування|cancel|cancel appointment|cancel visit)$/iu;

const DIRECT_RESCHEDULE_INTENT = /^(?:перенести|перенесення|reschedule|reschedule appointment|reschedule visit|move appointment|move visit)$/iu;

const isDirectCancelIntent = (state: ClinicState): boolean =>
  DIRECT_CANCEL_INTENT.test(lastPatientText(state).trim());

const isDirectRescheduleIntent = (state: ClinicState): boolean =>
  DIRECT_RESCHEDULE_INTENT.test(lastPatientText(state).trim());

function cancelConfirmationMessage(): string {
  return "Скасувати цей візит? Після підтвердження запис буде скасовано.";
}

/**
 * A direct move from «Мій запис» has one authoritative target. Keep the
 * availability query tied to that target so its current slot is not offered
 * again and a model-generated DATE prompt cannot bypass the lookup.
 */
const rescheduleAvailabilityArgsFromBookingContext = (
  state: ClinicState,
  args: Record<string, unknown> = {},
): Record<string, unknown> | null => {
  if (!isDirectRescheduleIntent(state) || state.bookingContext?.meetings.length !== 1) {
    return null;
  }
  const meeting = state.bookingContext.meetings[0];
  if (!meeting) {
    return null;
  }
  const durationMinutes = state.bookingDraft?.serviceAcceptance?.service.durationMinutes;
  return {
    ...args,
    direction: args.direction ?? "nearest",
    excludeMeetingIds: [meeting.id],
    ...(durationMinutes != null ? { durationMinutes } : {}),
  };
};

/** Build a cancellation command from the supervisor's authoritative meeting list. */
const cancelCommandFromBookingContext = (
  state: ClinicState,
): PendingBookingCommand | null => {
  if (!isDirectCancelIntent(state) || state.bookingContext?.meetings.length !== 1) {
    return null;
  }
  const meeting = state.bookingContext.meetings[0];
  if (!meeting) {
    return null;
  }
  const payload: Record<string, unknown> = {
    meetingId: meeting.id,
    confirmMessage: cancelConfirmationMessage(),
    ...(meeting.name ? { name: meeting.name } : {}),
  };
  for (const [key, value] of [
    ["dateStart", meeting.dateStart],
    ["dateEnd", meeting.dateEnd],
  ] as const) {
    try {
      payload[key] = normalizeLocalIsoDatetime(value);
    } catch {
      // The meeting id is authoritative; CRM can fill a malformed display date.
    }
  }
  return {
    action: "cancel",
    payload,
    idempotencyKey: commandIdempotencyKey("cancel", payload),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
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
    return {
      ...draft.replacement.originalCommand,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }
  const acceptance = draft?.serviceAcceptance;
  const slot = draft?.selectedSlot;
  const contactId = draft?.contactId
    ?? state.contactContext?.contacts.find(
      (contact) => typeof contact.id === "string" && contact.id.length > 0,
    )?.id;
  if (
    !draft
    || acceptance?.status !== "accepted"
    || slot == null
    || !contactId
    || (draft.note.status !== "skipped" && draft.note.status !== "answered")
  ) {
    return null;
  }
  const contact = state.contactContext?.contacts.find((row) => row.id === contactId);
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
  return {
    action: "create",
    payload,
    idempotencyKey: commandIdempotencyKey("create", payload),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
};

const bookingDraftCanPrepareCommand = (state: ClinicState): boolean => {
  if (cancelCommandFromBookingContext(state) != null
    && !toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")) {
    return true;
  }
  if (createCommandFromBookingDraft(state) == null) {
    return false;
  }
  if (!toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")) {
    return state.bookingDraft?.replacement?.status === "create_pending";
  }
  const lastAi = [...(state.agentMessages ?? [])]
    .reverse()
    .find((message) => message instanceof AIMessage);
  const calls = lastAi instanceof AIMessage ? (lastAi.tool_calls ?? []) : [];
  return state.bookingDraft?.replacement?.status === "create_pending"
    || calls.length === 0
    || calls.some((call) => call.name === "create_meeting");
};

const REPLACEMENT_CANCEL_LABELS = new Set(["скасувати", "cancel", "так", "yes"]);
const REPLACEMENT_DECLINE_LABELS = new Set(["ні, дякую", "no, thanks"]);

const replacementActionForTurn = (
  state: ClinicState,
): "cancel" | "decline" | null => {
  const replacementStatus = state.bookingDraft?.replacement?.status;
  if (replacementStatus !== "offered" && replacementStatus !== "cancelling") {
    return null;
  }
  const text = lastPatientText(state).trim().toLocaleLowerCase();
  if (REPLACEMENT_CANCEL_LABELS.has(text)) {
    return "cancel";
  }
  if (REPLACEMENT_DECLINE_LABELS.has(text)) {
    return "decline";
  }
  return null;
};

const cancelCommandFromReplacement = (
  state: ClinicState,
): PendingBookingCommand | null => {
  const replacement = state.bookingDraft?.replacement;
  if (!replacement) {
    return null;
  }
  const meeting = replacement.meeting;
  const payload: Record<string, unknown> = {
    meetingId: meeting.id,
    confirmMessage: cancelConfirmationMessage(),
    ...(meeting.name ? { name: meeting.name } : {}),
    ...(replacement.status === "cancelling" ? { confirmationGiven: true } : {}),
  };
  for (const [key, value] of [
    ["dateStart", meeting.dateStart],
    ["dateEnd", meeting.dateEnd],
  ] as const) {
    if (!value) {
      continue;
    }
    try {
      payload[key] = normalizeLocalIsoDatetime(value);
    } catch {
      // CRM can fill an omitted/invalid display date; the meeting id is authoritative.
    }
  }
  return {
    action: "cancel",
    payload,
    idempotencyKey: commandIdempotencyKey("cancel", payload),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
};

/** Turn Gemini XML-in-content into `tool_calls`; inject slots when booking skipped the tool. */
const coerceAvailabilityToolCalls = (
  response: AIMessage,
  state: ClinicState,
  agentId: string,
  allowedToolNames: ReadonlySet<string>,
): AIMessage => {
  const raw = extractRawMessageText(response.content);
  const leaked = parseLeakedModelToolCalls(raw).filter((call) =>
    allowedToolNames.has(call.name),
  );
  const existing = response.tool_calls ?? [];
  let toolCalls = existing;
  if (existing.length === 0 && leaked.length > 0) {
    toolCalls = leaked.map((call, index) => ({
      id: `leaked_${call.name}_${index}`,
      name: call.name,
      args: call.args,
      type: "tool_call" as const,
    }));
  }
  if (
    agentId === BOOKING_AGENT_ID
    && !toolCalls.some((call) => call.name === "present_availability_slots")
  ) {
    const human = lastPatientText(state);
    const days = state.availabilityContext?.days ?? [];
    const request = resolveAvailabilityRequest(human, kyivToday());
    const dayPick = matchAvailabilityDay(human, days);
    const consultationAccepted = isConsultationOfferAcceptance(state);
    const semanticDirection = consultationAccepted
      ? "nearest"
      : request?.kind === "earlier" || request?.kind === "later" || request?.kind === "nearest"
        ? request.kind
        : isYesReply(human) ? "nearest" : undefined;
    // Recovery is allowed only for a structured patient action. Never turn arbitrary
    // availability-looking prose into an argument-less call that can replay a cache.
    if (
      !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")
      && dayPick == null
      && (request != null || semanticDirection != null)
    ) {
      const args = request?.kind === "exact"
        ? { direction: "exact", date: request.date }
        : { direction: semanticDirection ?? "nearest" };
      toolCalls = [
        ...toolCalls,
        {
          id: `slots_coerce_${state.stepCount ?? 0}`,
          name: "present_availability_slots",
          args,
          type: "tool_call" as const,
        },
      ];
    }
  }

  // Rescheduling is a runtime-owned availability transition. A model may ask
  // the patient to choose a day without emitting the required tool call; when
  // the supervisor has exactly one authoritative visit, synthesize the query
  // and bind it to that visit. Multiple visits remain model/selection-driven.
  if (
    agentId === BOOKING_AGENT_ID
    && !toolCalls.some((call) => call.name === "present_availability_slots")
  ) {
    const args = rescheduleAvailabilityArgsFromBookingContext(state);
    if (args && !toolRanThisTurn(state.agentMessages ?? [], "present_availability_slots")) {
      toolCalls = [
        ...toolCalls,
        {
          id: `slots_reschedule_${state.stepCount ?? 0}`,
          name: "present_availability_slots",
          args,
          type: "tool_call" as const,
        },
      ];
    }
  }

  const contentWasString = typeof response.content === "string";
  let nextContent: AIMessage["content"] = response.content;
  let contentChanged = false;
  if (contentWasString) {
    const original = response.content as string;
    const stripped = stripLeakedModelToolCalls(original);
    if (stripped !== original) {
      nextContent = stripped;
      contentChanged = true;
    }
  } else if (Array.isArray(response.content)) {
    const originalParts = response.content;
    const strippedParts = originalParts.map((part) => {
      if (typeof part === "string") {
        return stripLeakedModelToolCalls(part);
      }
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        const text = String((part as { text: string }).text);
        const stripped = stripLeakedModelToolCalls(text);
        return stripped === text ? part : { ...part, text: stripped };
      }
      return part;
    });
    const partsChanged = strippedParts.some((part, index) => part !== originalParts[index]);
    if (partsChanged) {
      nextContent = strippedParts as typeof response.content;
      contentChanged = true;
    }
  } else {
    const stripped = stripLeakedModelToolCalls(raw);
    if (stripped !== raw) {
      nextContent = stripped;
      contentChanged = true;
    }
  }

  if (!contentChanged && toolCalls === existing) {
    return response;
  }

  return new AIMessage({
    content: nextContent,
    tool_calls: toolCalls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
  });
};

/** Match a patient day pick to a snapshot day (keyboard short label, dayLabel, or YYYY-MM-DD). */
export const matchAvailabilityDay = (
  humanText: string,
  days: AvailabilityContext["days"],
): AvailabilityContext["days"][number] | null => {
  const trimmed = humanText.trim();
  if (!trimmed || isOtherDateHuman(trimmed)) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  for (const day of days) {
    if (day.slots.length === 0) {
      continue;
    }
    const dayLabel = day.dayLabel ?? day.date;
    const short = shortDayMonthLabel(dayLabel);
    if (
      trimmed === day.date
      || trimmed === dayLabel
      || trimmed === short
      || normalized === dayLabel.toLowerCase()
      || normalized === short.toLowerCase()
    ) {
      return day;
    }
  }
  return null;
};

const clockKey = (text: string): string | null => {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    return null;
  }
  return `${Number(match[1])}:${match[2] ?? "00"}`;
};

/** Match a patient clock-time pick to a snapshot slot (label, HH:mm, or bare hour). */
export const matchAvailabilitySlot = (
  humanText: string,
  availabilityContext: AvailabilityContext | null | undefined,
  selectedDate?: string | null,
): SelectedBookingSlot | null => {
  if (!availabilityContext || availabilityContext.days.length === 0) {
    return null;
  }
  const trimmed = humanText.trim();
  if (!trimmed || isOtherDateHuman(trimmed)) {
    return null;
  }
  const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
  const wantClock = clockKey(normalized);
  const openDays = availabilityContext.days.filter((day) => day.slots.length > 0);
  // A bare time is safe without an explicit day only for a single-day snapshot.
  // With multiple days, choosing the first matching clock time silently books the
  // wrong day when common hours occur on more than one date.
  const candidateDays = selectedDate != null
    ? availabilityContext.days.filter((day) => day.date === selectedDate)
    : openDays.length === 1
      ? openDays
      : [];
  for (const day of candidateDays) {
    for (const slot of day.slots) {
      const labelNorm = slot.label.trim().toLowerCase().replace(/\s+/g, "");
      if (normalized === labelNorm || (wantClock != null && clockKey(labelNorm) === wantClock)) {
        return {
          snapshotId: availabilitySnapshotId(availabilityContext),
          slotId: slot.id,
          dateStart: slot.dateStart,
          dateEnd: slot.dateEnd,
          label: slot.label,
        };
      }
    }
  }
  return null;
};

const NOTE_SKIP_REPLIES = new Set(
  [
    INTENT_SKIP_LABEL,
    INTENT_SKIP_LABEL_EN,
    "no",
    "ні",
    "нет",
    "без коментаря",
    "без коментарів",
    "не треба",
    "не потрібно",
    "skip",
  ].map((label) => label.toLowerCase()),
);

const isNoteSkipReply = (humanText: string): boolean =>
  NOTE_SKIP_REPLIES.has(humanText.trim().toLowerCase());

const noteStepBlocksCreate = (status: BookingNoteStatus | null | undefined): boolean =>
  status !== "skipped" && status !== "answered";

const CREATE_NOTE_REQUIRED_ERROR = "Note step required";

const PHONE_GROUNDED_TOOLS = new Set([
  "find_contact_by_phone",
  "create_contact",
  "update_contact",
]);

const PHONE_NOT_PROVIDED_ERROR = "Phone not provided";
const NAME_NOT_PROVIDED_ERROR = "Name not provided";

/** True when some HumanMessage in `messages` normalizes to the same E.164 as `wanted`. */
const humanProvidedPhone = (messages: BaseMessage[], wanted: string): boolean =>
  messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    return normalizeClinicPhone(extractMessageTextContent(message.content)) === wanted;
  });

/**
 * True when some HumanMessage equals `wanted` (trim + casefold), or is two whitespace
 * tokens and `wanted` equals token 0 or 1 (DDD-59 name grounding).
 */
const humanProvidedName = (messages: BaseMessage[], wanted: string): boolean => {
  const target = wanted.trim().toLowerCase();
  if (target.length === 0) {
    return false;
  }
  return messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    const text = extractMessageTextContent(message.content).trim().toLowerCase();
    if (text === target) {
      return true;
    }
    const parts = text.split(/\s+/).filter((part) => part.length > 0);
    return parts.length === 2 && (parts[0] === target || parts[1] === target);
  });
};

/**
 * Advance / reset the note ladder from the latest human line before the booking LLM runs.
 * Always ask once after a time pick — even if they named a procedure earlier.
 */
export const advanceBookingNoteStep = (state: ClinicState): ClinicStateUpdate => {
  const human = lastHumanText(state.messages);
  if (!human || human === MAIN_MENU_LABEL) {
    return {};
  }
  const status = authoritativeNoteStatus(state);
  const availability = state.availabilityContext;
  const matchedDay = matchAvailabilityDay(human, availability?.days ?? []);
  const explicitDate = resolveAvailabilityRequest(human, kyivToday());

  // Date intent wins over free-text note interpretation. A date outside the
  // current snapshot is still a date change, not a visit note.
  if (
    explicitDate?.kind === "exact"
    && explicitDate.date !== (state.bookingDraft?.selectedDate ?? state.selectedAvailabilityDate)
  ) {
    trackEvent("booking_date_selected", { date: explicitDate.date });
    const bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "date_selected",
      date: explicitDate.date,
    });
    return {
      ...(state.bookingDraft == null
        ? {
            bookingNoteStatus: status,
            selectedAvailabilityDate: explicitDate.date,
            selectedSlot: null,
          }
        : {}),
      bookingDraft,
    };
  }

  // DATE is a state transition, not just a presentation choice. Keep it until
  // the following TIME message so repeated clock labels cannot resolve against
  // another day in the same availability page.
  if (matchedDay) {
    trackEvent("booking_date_selected", { date: matchedDay.date });
    const bookingDraft = reduceBookingDraft(state.bookingDraft, {
      type: "date_selected",
      date: matchedDay.date,
    });
    return {
      ...(state.bookingDraft == null
        ? {
            bookingNoteStatus: "unasked" as const,
            selectedAvailabilityDate: matchedDay.date,
            selectedSlot: null,
          }
        : {}),
      bookingDraft,
    };
  }

  const selectedDate = state.bookingDraft?.selectedDate
    ?? state.selectedAvailabilityDate
    ?? (authoritativeSelectedSlot(state)?.dateStart.slice(0, 10) || null);
  const expectedDuration = state.bookingDraft?.serviceAcceptance?.service.durationMinutes;
  const availabilityMatchesService = availability == null
    || (availability.serviceId == null
      ? expectedDuration == null || availability.stepMinutes === expectedDuration
      : availability.serviceId === state.bookingDraft?.serviceAcceptance?.service.id
        && (expectedDuration == null || availability.stepMinutes === expectedDuration));
  const matchedSlot = availabilityMatchesService
    ? matchAvailabilitySlot(human, availability, selectedDate)
    : null;

  const sameSlot =
    matchedSlot != null
    && authoritativeSelectedSlot(state) != null
    && authoritativeSelectedSlot(state)!.dateStart === matchedSlot.dateStart;

  // A displayed note prompt and its typed reply must be one runtime-owned
  // transition. Accept the skip/value even if an older checkpoint still says
  // `unasked`.
  if (authoritativeSelectedSlot(state) != null && status === "unasked") {
    if (isNoteSkipReply(human)) {
      trackEvent("booking_note_step", { phase: "skipped" });
      return {
        ...(state.bookingDraft == null ? { bookingNoteStatus: "skipped" as const } : {}),
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "note_status",
          status: "skipped",
        }),
      };
    }
    if (!matchedSlot && human.length > 0) {
      trackEvent("booking_note_step", { phase: "answered" });
      return {
        ...(state.bookingDraft == null ? { bookingNoteStatus: "answered" as const } : {}),
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "note_status",
          status: "answered",
          value: human,
        }),
      };
    }
  }

  if (status === "awaiting") {
    if (isNoteSkipReply(human) || sameSlot) {
      trackEvent("booking_note_step", { phase: "skipped" });
      return {
        ...(state.bookingDraft == null ? { bookingNoteStatus: "skipped" as const } : {}),
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "note_status",
          status: "skipped",
        }),
      };
    }
    if (matchedSlot) {
      trackEvent("booking_note_step", { phase: "awaiting" });
      return {
        ...(state.bookingDraft == null
          ? {
              bookingNoteStatus: "awaiting" as const,
              selectedAvailabilityDate: matchedSlot.dateStart.slice(0, 10),
              selectedSlot: matchedSlot,
            }
          : {}),
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "slot_selected",
          slot: matchedSlot,
        }),
      };
    }
    trackEvent("booking_note_step", { phase: "answered" });
    return {
      ...(state.bookingDraft == null ? { bookingNoteStatus: "answered" as const } : {}),
      bookingDraft: reduceBookingDraft(state.bookingDraft, {
        type: "note_status",
        status: "answered",
        value: human,
      }),
    };
  }

  if (matchedSlot && (status === "unasked" || !sameSlot)) {
    trackEvent("booking_note_step", { phase: "awaiting" });
    return {
      ...(state.bookingDraft == null
        ? {
            bookingNoteStatus: "awaiting" as const,
            selectedAvailabilityDate: matchedSlot.dateStart.slice(0, 10),
            selectedSlot: matchedSlot,
          }
        : {}),
      bookingDraft: reduceBookingDraft(state.bookingDraft, {
        type: "slot_selected",
        slot: matchedSlot,
      }),
    };
  }

  return {};
};

const resetBookingNoteState = (state?: ClinicState): ClinicStateUpdate =>
  state?.bookingDraft == null
    ? { bookingNoteStatus: "unasked", selectedSlot: null, selectedAvailabilityDate: null }
    : {};

/**
 * When present_availability_slots ran this turn, replace invented DATE/TIME copy with the
 * snapshot. Multi-day → DATE; one day → TIME. Returns null when this turn is not a slot offer.
 */
export const availabilityOfferFromToolTurn = (
  messages: BaseMessage[],
): { replyText: string; replyButtons: string[] } | null => {
  if (!toolRanThisTurn(messages, "present_availability_slots")) {
    return null;
  }
  const captured = captureAvailabilityFromMessages(messages);
  if (!captured) {
    return null;
  }
  const open = captured.days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return formatAvailabilityEmptyOffer(captured);
  }
  if (open.length === 1) {
    return formatAvailabilityTimeOffer(open[0]!);
  }
  return formatAvailabilityDateOffer(captured);
};

/**
 * Code-owned DATE/TIME for booking finalize: TIME when the latest human message picks a
 * snapshot day (even if this-turn present_availability_slots returned a multi-day DATE);
 * else DATE/TIME from this-turn tool snapshot.
 */
export const resolveAvailabilityOffer = (
  messages: BaseMessage[],
  availabilityContext: AvailabilityContext | null | undefined,
): { replyText: string; replyButtons: string[] } | null => {
  const days =
    captureAvailabilityFromMessages(messages)?.days ?? availabilityContext?.days ?? [];
  const day = matchAvailabilityDay(lastHumanText(messages), days);
  if (day) {
    return formatAvailabilityTimeOffer(day);
  }
  return availabilityOfferFromToolTurn(messages);
};

export const crmWriteDirtiesPrefetch = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const name = message.name;
    if (!name || !PREFETCH_INVALIDATING_TOOLS.has(name)) {
      return false;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return false;
    }
    const record = asJsonRecord(body);
    if (!record) {
      return true;
    }
    if (typeof record.error === "string") {
      return name === "cancel_meeting";
    }
    return record.cancelled !== true && record.awaitingConfirmation !== true;
  });

/** Latest this-turn create_meeting JSON `error`, or undefined. */
const latestCreateMeetingError = (messages: BaseMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return undefined;
    }
    const record = asJsonRecord(body);
    return typeof record?.error === "string" ? record.error : undefined;
  }
  return undefined;
};

export const createMeetingAlreadyBooked = (messages: BaseMessage[]): boolean =>
  latestCreateMeetingError(messages) === "Already booked";

const alreadyBookedMeetingFromMessages = (
  messages: BaseMessage[],
): ReplacementMeeting | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "create_meeting") {
      continue;
    }
    const record = asJsonRecord(extractMessageTextContent(message.content).trim());
    if (record?.error !== "Already booked" || !Array.isArray(record.meetings)) {
      return null;
    }
    const meeting = asJsonRecord(record.meetings[0]);
    if (!meeting || typeof meeting.id !== "string" || meeting.id.length === 0) {
      return null;
    }
    return {
      id: meeting.id,
      ...(typeof meeting.name === "string" ? { name: meeting.name } : {}),
      ...(typeof meeting.dateStart === "string" ? { dateStart: meeting.dateStart } : {}),
      ...(typeof meeting.dateEnd === "string" ? { dateEnd: meeting.dateEnd } : {}),
    };
  }
  return null;
};

const SLOT_JUST_TAKEN_PREFIX = "На жаль, обраний час щойно зайняли.\n\n";

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

const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (isModelFailureMessage(message)) {
    return "error";
  }

  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

export const createAgentPrepareNode = (agentId: string) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
      stepCount: 0,
    };
    if (agentId === BOOKING_AGENT_ID) {
      // Fold all events from this turn into one local aggregate. In particular,
      // service acceptance and the date/time/note ladder must never each reduce
      // from the stale checkpoint and then overwrite one another.
      let bookingDraft = bookingDraftForTurn(state) ?? state.bookingDraft ?? undefined;
      const workingState: ClinicState = bookingDraft
        ? { ...state, bookingDraft }
        : state;
      const noteUpdate = advanceBookingNoteStep(workingState);
      // Legacy projections are returned only for old checkpoints that have no
      // draft. New flows receive a single aggregate update.
      Object.assign(update, noteUpdate);
      bookingDraft = (noteUpdate.bookingDraft as BookingDraft | undefined) ?? bookingDraft;
      const contactId = state.contactContext?.contacts.find(
        (contact) => typeof contact.id === "string" && contact.id.length > 0,
      )?.id;
      if (bookingDraft && typeof contactId === "string" && contactId !== bookingDraft.contactId) {
        bookingDraft = reduceBookingDraft(bookingDraft, {
          type: "contact_resolved",
          contactId,
        });
      }
      if (bookingDraft) {
        update.bookingDraft = bookingDraft;
      }
    }
    return update;
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
    // Replacement is a compound mutation. Once it has started, the original
    // patient message (often `Скасувати`) and the stale meeting snapshot must
    // not be interpreted as a new direct-cancellation request. The replacement
    // phase is the authoritative source for the next command.
    const replacementStatus = state.bookingDraft?.replacement?.status;
    const replacementInProgress = replacementStatus === "offered"
      || replacementStatus === "cancelling"
      || replacementStatus === "create_pending";
    const directCancelCommand = replacementInProgress
      ? null
      : cancelCommandFromBookingContext(state);
    if (
      directCancelCommand
      && !toolRanThisTurn(state.agentMessages ?? [], "cancel_meeting")
    ) {
      const lastAiIndex = [...(state.agentMessages ?? [])]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find(({ message }) => message instanceof AIMessage)?.index;
      const syntheticCall = {
        id: `booking_direct_cancel_${state.bookingDraft?.version ?? 0}`,
        name: "cancel_meeting",
        args: directCancelCommand.payload,
        type: "tool_call" as const,
      };
      const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
      const messages = state.agentMessages ?? [];
      const agentMessages = lastAiIndex == null
        ? [...messages, syntheticAi]
        : [
            ...messages.slice(0, lastAiIndex),
            syntheticAi,
            ...messages.slice(lastAiIndex + 1),
          ];
      return {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: directCancelCommand,
        }),
        pendingCancellationPurpose: "direct",
        agentMessages: new Overwrite(agentMessages),
      };
    }
    const replacementAction = replacementActionForTurn(state);
    if (replacementAction === "decline") {
      return {
        bookingDraft: reduceBookingDraft(state.bookingDraft, { type: "cancel_existing_declined" }),
        agentMessages: new Overwrite([]),
      };
    }
    if (replacementAction === "cancel") {
      const cancelCommand = cancelCommandFromReplacement(state);
      if (cancelCommand) {
        const lastAiIndex = [...(state.agentMessages ?? [])]
          .map((message, index) => ({ message, index }))
          .reverse()
          .find(({ message }) => message instanceof AIMessage)?.index;
        const syntheticCall = {
          id: `booking_replace_cancel_${state.bookingDraft?.version ?? 0}`,
          name: "cancel_meeting",
          args: cancelCommand.payload,
          type: "tool_call" as const,
        };
        const syntheticAi = new AIMessage({ content: "", tool_calls: [syntheticCall] });
        const messages = state.agentMessages ?? [];
        const agentMessages = lastAiIndex == null
          ? [...messages, syntheticAi]
          : [
              ...messages.slice(0, lastAiIndex),
              syntheticAi,
              ...messages.slice(lastAiIndex + 1),
            ];
        return {
          bookingDraft: reduceBookingDraft(state.bookingDraft, {
            type: "cancel_existing_requested",
            command: cancelCommand,
          }),
          pendingCancellationPurpose: "replacement",
          agentMessages: new Overwrite(agentMessages),
        };
      }
    }
    if (
      state.bookingDraft?.replacement?.status === "offered"
      || state.bookingDraft?.replacement?.status === "cancelling"
    ) {
      return {};
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
      return { agentMessages: new Overwrite([...messages, revalidationAi]) };
    }
    if (draftCommand && bookingDraftCanPrepareCommand(state)) {
      const lastAiIndex = [...(state.agentMessages ?? [])]
        .map((message, index) => ({ message, index }))
        .reverse()
        .find(({ message }) => message instanceof AIMessage)?.index;
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
      const agentMessages = lastAiIndex == null
        ? [...messages, syntheticAi]
        : [
            ...messages.slice(0, lastAiIndex),
            syntheticAi,
            ...messages.slice(lastAiIndex + 1),
          ];
      return {
        bookingDraft: reduceBookingDraft(state.bookingDraft, {
          type: "command_prepared",
          command: draftCommand,
        }),
        agentMessages: new Overwrite(agentMessages),
      };
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
    const command: PendingBookingCommand = {
      action,
      payload,
      idempotencyKey: commandIdempotencyKey(action, payload),
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
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
    return {
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
  };

export const createAgentLlmNode = (options: CreateAgentLoopOptions) => {
  const { agent, model, tools, formatSystemMetadata } = options;
  const cache = options.contextCache;

  if (typeof model.bindTools !== "function") {
    throw new Error(`Agent ${agent.id} model must support tool calling.`);
  }

  const boundModel = model.bindTools(tools);
  const displayName = cache?.displayName ?? `clinic-${agent.id}`;
  const allowedToolNames = new Set(tools.map((tool) => tool.name));

  const invokeUncached = async (
    staticPrompt: string,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) =>
    boundModel.invoke(buildUncachedMessages(staticPrompt, dynamic, history), config);

  const invokeCached = async (
    handle: ContextCacheHandle,
    dynamic: string,
    history: BaseMessage[],
    config?: RunnableConfig,
  ) => {
    const cachedModel = createCachedGeminiModel(cache!.apiKey, cache!.modelName, handle);
    // Tools and system instruction live in CachedContent — must not be sent again on generateContent.
    return cachedModel.invoke(buildCachedMessages(dynamic, history), config);
  };

  const cacheSpec = (staticPrompt: string) => ({
    modelName: cache!.modelName,
    staticSystemInstruction: staticPrompt,
    tools,
    displayName,
  });

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    if (hasPendingToolCalls(state.agentMessages)) {
      return { stepCount: state.stepCount };
    }

    const last = state.agentMessages[state.agentMessages.length - 1];
    const isContinuation = last instanceof ToolMessage;
    const stepCount = isContinuation ? state.stepCount + 1 : 1;

    const staticPrompt = agent.systemPrompt.trim();
    const dynamicParts = [
      formatSystemMetadata(new Date(), { runtimeAgent: agent.name }).trim(),
      agent.id === BOOKING_AGENT_ID ? formatContactContext(state.contactContext) : "",
      agent.id === BOOKING_AGENT_ID
        ? formatBookingMeetingsContext(state.bookingContext)
        : formatPlannedVisitsFlag(state.bookingContext),
    ];
    // Full days[] lives in the slots tool result / checkpoint — do not also bill Gemini for it.
    // BookingDraft is the single compact projection of the selected slot.
    if (agent.id === BOOKING_AGENT_ID) {
      dynamicParts.push(formatBookingDraftContext(state.bookingDraft));
    }
    if (
      (agent.id === FAQ_AGENT_ID || agent.id === BOOKING_AGENT_ID)
      && !toolRanThisTurn(state.agentMessages, "list_services")
    ) {
      dynamicParts.push(formatServicesContext(state.servicesContext));
    }
    const dynamic = dynamicParts.filter((part) => part.length > 0).join("\n\n");

    try {
      let handle: ContextCacheHandle | null = null;
      if (cache) {
        handle = await cache.manager.getOrCreate(cacheSpec(staticPrompt));
      }

      let response: AIMessage;
      if (handle) {
        try {
          response = (await invokeCached(
            handle,
            dynamic,
            state.agentMessages,
            config,
          )) as AIMessage;
        } catch (error) {
          if (!isCachedContentNotFoundError(error)) {
            throw error;
          }
          cache!.manager.invalidate(handle.cacheName);
          const recreated = await cache!.manager.getOrCreate(cacheSpec(staticPrompt));
          response = (recreated
            ? await invokeCached(recreated, dynamic, state.agentMessages, config)
            : await invokeUncached(staticPrompt, dynamic, state.agentMessages, config)) as AIMessage;
        }
      } else {
        response = (await invokeUncached(
          staticPrompt,
          dynamic,
          state.agentMessages,
          config,
        )) as AIMessage;
      }

      return {
        agentMessages: [coerceAvailabilityToolCalls(response, state, agent.id, allowedToolNames)],
        stepCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[clinic-${agent.id}] model call failed:`, message);
      return {
        agentMessages: [tagModelFailureMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE))],
        stepCount,
      };
    }
  };
};

export const createAgentToolsNode = (
  tools: StructuredToolInterface[],
  agentId?: string,
) => {
  const toolNode = new ToolNode(tools);

  return async (state: ClinicState, config?: RunnableConfig): Promise<ClinicStateUpdate> => {
    const agentMessages = state.agentMessages ?? [];
    let lastAiIndex = -1;
    for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
      const message = agentMessages[index];
      if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
        lastAiIndex = index;
        break;
      }
    }

    const synthetic: ToolMessage[] = [];
    const remainingCalls: NonNullable<AIMessage["tool_calls"]> = [];
    let noteStatusUpdate: ClinicStateUpdate = {};
    let availabilityPagedThisTurn = toolRanThisTurn(
      agentMessages,
      "present_availability_slots",
    );

    if (lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      for (const call of lastAi.tool_calls ?? []) {
        if (
          agentId === BOOKING_AGENT_ID
          && call.name === "create_meeting"
          && noteStepBlocksCreate(authoritativeNoteStatus(state))
        ) {
          noteStatusUpdate = state.bookingDraft == null
            ? { bookingNoteStatus: "awaiting" }
            : {
                bookingDraft: reduceBookingDraft(state.bookingDraft, {
                  type: "note_status",
                  status: "awaiting",
                }),
              };
          trackEvent("booking_create_blocked_note", {
            phase: authoritativeNoteStatus(state),
          });
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: CREATE_NOTE_REQUIRED_ERROR,
                hint:
                  "Ask the optional visit-note question once (STEP INTENT) with the skip shortcut. Do not call create_meeting until the patient skips, declines, or shares a note.",
              }),
              tool_call_id: call.id ?? "",
              name: "create_meeting",
            }),
          );
          continue;
        }

        if (
          blocksConsultationWithoutAgreement(agentId, call, state)
        ) {
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: CREATE_CONSULTATION_REQUIRED_ERROR,
                hint:
                  "serviceId is the consultation id but the patient has not explicitly agreed to «Консультація» (Так after a consultation offer, or they named consultation). Do not present times or book consultation. If they named another procedure/family, that belongs to FAQ catalog browse — do not substitute consultation.",
              }),
              tool_call_id: call.id ?? "",
              name: call.name,
            }),
          );
          continue;
        }

        if (
          agentId === BOOKING_AGENT_ID
          && call.name === "create_meeting"
          && authoritativeSelectedSlot(state) == null
          && (state.availabilityContext?.days.filter((day) => day.slots.length > 0).length ?? 0) > 1
        ) {
          trackToolError(call.name, SLOT_SELECTION_REQUIRED_ERROR);
          synthetic.push(
            new ToolMessage({
              content: JSON.stringify({
                error: SLOT_SELECTION_REQUIRED_ERROR,
                hint:
                  "Ask the patient to choose a day and then a time from the current availability. Do not invent a date.",
              }),
              tool_call_id: call.id ?? "",
              name: call.name,
            }),
          );
          continue;
        }

        if (PHONE_GROUNDED_TOOLS.has(call.name)) {
          const rawPhone = (call.args ?? {}).phoneNumber;
          if (typeof rawPhone === "string" && rawPhone.trim() !== "") {
            const wanted = normalizeClinicPhone(rawPhone);
            if (
              wanted != null
              && !humanProvidedPhone(state.messages ?? [], wanted)
            ) {
              trackToolError(call.name, PHONE_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: PHONE_NOT_PROVIDED_ERROR,
                    hint:
                      "Ask the patient for their clinic phone, then retry with the number they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }

          if (call.name === "create_contact" || call.name === "update_contact") {
            const args = call.args ?? {};
            const nameFields = ["firstName", "lastName"] as const;
            const invented = nameFields.find((field) => {
              const raw = args[field];
              return (
                typeof raw === "string"
                && raw.trim() !== ""
                && !humanProvidedName(state.messages ?? [], raw)
              );
            });
            if (invented) {
              trackToolError(call.name, NAME_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: NAME_NOT_PROVIDED_ERROR,
                    hint:
                      "Ask the patient for their name, then retry with the value they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }
        }

        if (call.name === "create_meeting" || call.name === "reschedule_meeting") {
          call.args = normalizeMeetingMutationArgs(state, call);
          const args = call.args as {
            dateStart?: string;
            dateEnd?: string;
            serviceId?: string;
            contactId?: string;
          };
          const selectedSlot = authoritativeSelectedSlot(state);
          if (selectedSlot) {
            const availability = state.bookingDraft?.selectedSlot
              ? state.availabilityContext
              : null;
            const selectedDay = availability?.days.find(
              (day) => day.date === selectedSlot.dateStart.slice(0, 10),
            );
            const expectedDuration = state.bookingDraft?.serviceAcceptance?.service.durationMinutes;
            const snapshotMatchesService = availability == null
              || (availability.serviceId == null
                ? expectedDuration == null || availability.stepMinutes === expectedDuration
                : availability.serviceId === state.bookingDraft?.serviceAcceptance?.service.id
                  && (expectedDuration == null || availability.stepMinutes === expectedDuration));
            const selectedSlotStillAvailable = snapshotMatchesService
              && (availability == null
                || selectedDay == null
                ? availability == null
                : selectedDay.slots.some((slot) =>
                  slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
                ));
            if (!selectedSlotStillAvailable) {
              trackToolError(call.name, SELECTED_SLOT_NOT_AVAILABLE_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: SELECTED_SLOT_NOT_AVAILABLE_ERROR,
                    hint: "Refresh availability and offer another slot before booking.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }
          if (
            (call.name === "reschedule_meeting" || selectedSlot == null)
            && (
              !KYIV_LOCAL_ISO_SCHEMA.safeParse(args.dateStart).success
              || !KYIV_LOCAL_ISO_SCHEMA.safeParse(args.dateEnd).success
            )
          ) {
            trackToolError(call.name, "Invalid meeting datetime");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Invalid meeting datetime",
                  hint:
                    "Use YYYY-MM-DDTHH:mm:ss from <booking_draft> or present_availability_slots.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
        }

        if (call.name === "present_availability_slots") {
          // Own paging cursors from checkpoint — the model chooses semantic direction,
          // but must not invent calendar boundaries.
          const rescheduleArgs = rescheduleAvailabilityArgsFromBookingContext(
            state,
            (call.args ?? {}) as Record<string, unknown>,
          );
          const args = normalizeAvailabilityToolArgs({
            args: (rescheduleArgs ?? call.args ?? {}) as AvailabilitySlotsToolArgs,
            availabilityContext: state.availabilityContext,
            availabilityCursor: state.availabilityCursor,
            ...(state.bookingDraft?.serviceAcceptance?.service.durationMinutes != null
              ? { serviceDurationMinutes: state.bookingDraft.serviceAcceptance.service.durationMinutes }
              : {}),
            humanText: lastPatientText(state),
            pickedOfferedDay: matchAvailabilityDay(
              lastPatientText(state),
              state.availabilityContext?.days ?? [],
            ) != null,
            consultationAccepted: isConsultationOfferAcceptance(state),
            availabilityPagedThisTurn,
            anchors: bookingDateAnchors(state),
          });
          call.args = args;
          if (args.direction === "exact" && !args.date) {
            trackToolError(call.name, "Exact availability date missing");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Exact availability date missing",
                  hint: "Resolve the patient's named calendar date before searching availability.",
                }),
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
          const parsed = presentAvailabilitySlotsArgsSchema.safeParse(args);
          if (!parsed.success) {
            trackToolError(call.name, "Invalid availability arguments");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Invalid availability arguments",
                  hint:
                    "Use YYYY-MM-DD for date/afterDate/beforeDate/startDate; durationMinutes 15–180.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
          call.args = parsed.data;
          const hit = tryAvailabilityCacheHit(state.availabilityContext, parsed.data);
          if (hit) {
            trackEvent("availability_cache_hit", {
              outcome: "success",
              kind: hit.kind,
              ...(typeof parsed.data.date === "string" ? { date: parsed.data.date } : {}),
            });
            synthetic.push(
              new ToolMessage({
                content: hit.json,
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
          if (args.direction === "earlier" || args.direction === "later") {
            availabilityPagedThisTurn = true;
          }
        }

        remainingCalls.push(call);
      }
    }

    let toolResultMessages: BaseMessage[] = [];
    if (remainingCalls.length > 0 && lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      const originalCalls = lastAi.tool_calls ?? [];
      const messagesForTools =
        remainingCalls.length === originalCalls.length
          ? agentMessages
          : [
              ...agentMessages.slice(0, lastAiIndex),
              new AIMessage({
                content: lastAi.content,
                tool_calls: remainingCalls,
                additional_kwargs: lastAi.additional_kwargs,
                response_metadata: lastAi.response_metadata,
                id: lastAi.id,
              } as ConstructorParameters<typeof AIMessage>[0]),
              ...agentMessages.slice(lastAiIndex + 1),
            ];
      const result = await (
        toolNode as unknown as {
          run(
            input: { messages: BaseMessage[] },
            config?: RunnableConfig,
          ): Promise<{ messages: BaseMessage[] }>;
        }
      ).run({ messages: messagesForTools }, config);
      toolResultMessages = result.messages;
    }

    const resultMessages = [...synthetic, ...toolResultMessages];
    const replacementCancellationResult =
      state.bookingDraft?.replacement?.status === "cancelling"
      && resultMessages.some(
        (message) => message instanceof ToolMessage && message.name === "cancel_meeting",
      );
    const update: ClinicStateUpdate = {
      agentMessages: resultMessages,
      ...noteStatusUpdate,
      ...(replacementCancellationResult
        ? { pendingCancellationPurpose: "replacement" as const }
        : {}),
    };

    const pendingCommand = resultMessages
      .map((message) => {
        if (!(message instanceof ToolMessage)) {
          return null;
        }
        const record = asJsonRecord(extractMessageTextContent(message.content).trim());
        const draft = asJsonRecord(record?.draft);
        const command = asJsonRecord(draft?.command);
        if (
          record?.awaitingConfirmation !== true
          || (command?.action !== "create"
            && command?.action !== "reschedule"
            && command?.action !== "replace"
            && command?.action !== "cancel")
          || !asJsonRecord(command.payload)
          || typeof command.idempotencyKey !== "string"
        ) {
          return null;
        }
        return {
          action: command.action,
          payload: asJsonRecord(command.payload)!,
          idempotencyKey: command.idempotencyKey,
          expiresAt: Date.now() + 15 * 60 * 1000,
        } satisfies PendingBookingCommand;
      })
      .find((command): command is PendingBookingCommand => command != null);
    if (pendingCommand && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "command_prepared",
        command: pendingCommand,
      });
    }

    const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
    if (conflictMeeting && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "existing_booking_detected",
        meeting: conflictMeeting,
      });
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

    if (meetingMutationClearsAvailability(resultMessages)) {
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
      if (cancelCommitted && state.bookingDraft?.replacement?.status === "cancelling") {
        update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
          type: "cancel_existing_completed",
        });
      } else if (cancelDeclined && state.bookingDraft?.replacement?.status === "cancelling") {
        update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
          type: "cancel_existing_declined",
        });
      } else if (!cancelOnlyCommitted) {
        Object.assign(update, resetBookingNoteState(state));
        const mutationFailed = resultMessages.some(
          (message) =>
            message instanceof ToolMessage
            && classifyMeetingMutationToolMessage(message) === "failed",
        );
        const mutationCommitted = committed.length > 0;
        if (state.bookingDraft && mutationFailed && !mutationCommitted) {
          // A CRM race/error invalidates only the slot. The accepted service and
          // visit note remain resumable for the next availability search.
          update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
            type: "slot_invalidated",
          });
        } else if (state.bookingDraft) {
          update.bookingDraft = null;
        }
      }
      if (
        resultMessages.some(
          (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
        )
      ) {
        trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
      }
    } else {
      const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
      if (capturedAvailability !== undefined) {
        const acceptedService = state.bookingDraft?.serviceAcceptance;
        const bookingAvailability = capturedAvailability != null
          && acceptedService?.status === "accepted"
          ? { ...capturedAvailability, serviceId: acceptedService.service.id }
          : capturedAvailability;
        update.availabilityContext = bookingAvailability;
        update.availabilityCursor = availabilityCursorFromContext(bookingAvailability);
        let bookingDraft = state.bookingDraft;
        if (bookingAvailability != null) {
          bookingDraft = reduceBookingDraft(bookingDraft, {
            type: "availability_loaded",
            snapshotId: availabilitySnapshotId(bookingAvailability),
            ...(bookingAvailability.query
              ? { query: JSON.stringify(bookingAvailability.query) }
              : {}),
          });
          update.bookingDraft = bookingDraft;
        }
        const selectedDate = bookingDraft != null
          ? bookingDraft.selectedDate
          : state.selectedAvailabilityDate;
        const selectedSlot = authoritativeSelectedSlot(state);
        const selectedDay = selectedDate == null
          ? undefined
          : bookingAvailability?.days.find((day) => day.date === selectedDate);
        const expectedDuration = bookingDraft?.serviceAcceptance?.service.durationMinutes;
        const snapshotMatchesService = bookingAvailability == null
          || (bookingAvailability.serviceId == null
            ? expectedDuration == null || bookingAvailability.stepMinutes === expectedDuration
            : bookingAvailability.serviceId === bookingDraft?.serviceAcceptance?.service.id
              && (expectedDuration == null || bookingAvailability.stepMinutes === expectedDuration));
        const selectedSlotStillAvailable = snapshotMatchesService
          && (selectedSlot == null
            || selectedDay?.slots.some((slot) =>
              slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
            ) === true);
        if (
          selectedDate != null
          && (
            bookingAvailability == null
            || selectedDay?.slots.length === 0
            || !selectedSlotStillAvailable
          )
        ) {
          if (bookingDraft == null) {
            update.selectedAvailabilityDate = null;
            update.selectedSlot = null;
            update.bookingNoteStatus = "unasked";
          }
          if (bookingDraft) {
            update.bookingDraft = reduceBookingDraft(bookingDraft, {
              type: "slot_invalidated",
              keepDate: selectedDay?.slots.length !== 0,
            });
          }
        }
      }
    }

    const capturedServices = captureServicesFromMessages(resultMessages);
    if (capturedServices !== undefined) {
      update.servicesContext = capturedServices;
    }

    const found = captureLatestToolContext(
      resultMessages,
      "find_contact_by_phone",
      normalizeContactLookupResult,
    );
    if (found && !found.error && found.contacts.length > 0) {
      update.contactContext = found;
    }

    if (crmWriteDirtiesPrefetch(resultMessages)) {
      update.prefetchDirty = true;
    }

    return update;
  };
};

/**
 * Complete a terminal cancellation outcome. The model is intentionally not
 * called again here: it must not turn a declined write into a success message
 * or ask for an action without supplying its keyboard.
 */
export const createAgentMutationFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState): ClinicStateUpdate => {
    const result = terminalCancellationOutcome(state);
    if (!result) {
      return {};
    }
    const outcome = classifyMeetingMutationToolMessage(result);
    const committed = outcome === "committed";
    const declined = outcome === "declined";
    const replacementCancellation = state.pendingCancellationPurpose === "replacement";
    const replyText = committed
      ? "Запис скасовано."
      : declined
        ? replacementCancellation
          ? "Скасування поточного візиту скасовано. Новий запис не було створено."
          : "Запис не було скасовано."
        : replacementCancellation
          ? "Не вдалося скасувати поточний візит, тому новий запис не створено. Спробуйте ще раз."
          : "Не вдалося скасувати запис. Спробуйте ще раз.";
    const replyButtons = committed
      ? [...defaultMenuLabels(defaultMenuHasVisit(state.agentMessages ?? [], state.bookingContext))]
      : replacementCancellation
        ? [...defaultMenuLabels(defaultMenuHasVisit(state.agentMessages ?? [], state.bookingContext))]
        : [...VISIT_CHANGE_MENU];
    const message = tagRuntimeAgentMessage(new AIMessage(replyText), agent.id);
    return {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
      // A direct cancellation is complete; do not leave its frozen command in
      // the draft for a later turn to replay.
      bookingDraft: null,
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

export const createAgentFinalizeNode = (agent: ClinicAgentDefinition) =>
  (state: ClinicState): ClinicStateUpdate => {
    const agentMessages = state.agentMessages ?? [];
    const stepCount = state.stepCount ?? 0;
    const lastMessage = agentMessages[agentMessages.length - 1];

    const cleared = {
      agentMessages: new Overwrite([] as BaseMessage[]),
      stepCount: 0,
    };

    if (!(lastMessage instanceof AIMessage)) {
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "empty",
        },
      };
    }

    const tagged = tagRuntimeAgentMessage(lastMessage, agent.id);
    const status = resolveHandoffStatus(tagged, stepCount, agent.maxSteps, agentMessages);
    const rawText = extractMessageTextContent(tagged.content);
    const { text, buttons: accidentalButtons, yieldToSupervisor: yieldTag } =
      extractReplyButtons(rawText);
    let replyText = text.trim();
    let replyButtons: string[] = [];
    let yieldFlag = false;

    // Model failure: deliver via handoff only — do not persist into conversation history.
    if (status === "error" && isModelFailureMessage(tagged)) {
      const hasVisit = (state.bookingContext?.meetings.length ?? 0) > 0;
      return {
        ...cleared,
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "error",
          replyText: PATIENT_FALLBACK_MESSAGE,
          ...(agent.id === BOOKING_AGENT_ID
            ? { replyButtons: [...defaultMenuLabels(hasVisit)] }
            : {}),
        },
      };
    }

    // Already booked / committed create win over DATE/TIME rewrite when both fire same turn.
    const alreadyBooked =
      agent.id === BOOKING_AGENT_ID && createMeetingAlreadyBooked(agentMessages);
    const replacementOffered =
      agent.id === BOOKING_AGENT_ID
      && state.bookingDraft?.replacement?.status === "offered";
    const createCommitted =
      agent.id === BOOKING_AGENT_ID
      && agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && message.name === "create_meeting"
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
    const createError = latestCreateMeetingError(agentMessages);
    const noteBlockedThisTurn = createError === CREATE_NOTE_REQUIRED_ERROR;
    const awaitingNote =
      agent.id === BOOKING_AGENT_ID
      && (authoritativeNoteStatus(state) === "awaiting" || noteBlockedThisTurn)
      && !alreadyBooked;
    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer =
      agent.id === BOOKING_AGENT_ID && !alreadyBooked && !createCommitted
        ? resolveAvailabilityOffer(agentMessages, state.availabilityContext)
        : null;
    if (replacementOffered) {
      replyButtons = [...BOOKING_REPLACE_MENU];
    } else if (slotOffer) {
      replyText =
        createError != null && !noteBlockedThisTurn
          ? `${SLOT_JUST_TAKEN_PREFIX}${slotOffer.replyText}`
          : slotOffer.replyText;
      replyButtons = slotOffer.replyButtons;
    } else if (awaitingNote) {
      // Code-own INTENT skip (DDD-48); force the note question when create was blocked (DDD-49/51).
      if (noteBlockedThisTurn || replyText.length === 0) {
        replyText = BOOKING_NOTE_QUESTION_UK;
      }
      replyButtons = [INTENT_SKIP_LABEL];
      trackEvent("reply_menu_filled", { menu: "intent_skip", reason: "code_owned" });
    } else if (alreadyBooked) {
      replyButtons = [...BOOKING_REPLACE_MENU];
    } else if (replyText.length > 0 && isBookingOfferQuestion(replyText)) {
      // DDD-79 / DDD-56: consultation / book-this-procedure yes/no from visible text.
      replyButtons = [...BOOKING_OFFER_MENU];
      if (agent.id === FAQ_AGENT_ID) {
        yieldFlag = true;
      }
      trackEvent("reply_menu_filled", { menu: "booking_offer", reason: "code_owned" });
    } else if (agent.id === FAQ_AGENT_ID && replyText.length > 0) {
      replyButtons = catalogChoiceButtonsFromText(replyText);
      if (replyButtons.length === 0) {
        // Accidental leftover trailer only — never the adapter markup channel.
        replyButtons = accidentalButtons;
      }
    } else if (agent.id === BOOKING_AGENT_ID && replyText.length > 0) {
      // DDD-54: DEFAULT MENU only on idle mutation turns — not phone/name mid-flow.
      const idle = agentMessages.some(
        (message) =>
          message instanceof ToolMessage
          && (classifyMeetingMutationToolMessage(message) === "committed"
            || meetingMutationIsHitlDecline(message)),
      );
      if (idle) {
        replyButtons = [
          ...defaultMenuLabels(defaultMenuHasVisit(agentMessages, state.bookingContext)),
        ];
        trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
      } else {
        // Booking drifted into catalog drill-down: never ship that list without its chips.
        replyButtons = catalogChoiceButtonsFromText(replyText);
      }
    }

    if (yieldTag && agent.id === FAQ_AGENT_ID) {
      yieldFlag = true;
    }

    const noteStatusForHandoff: ClinicStateUpdate =
      awaitingNote && !slotOffer
        ? state.bookingDraft
          ? {
              bookingDraft: state.bookingDraft.note.status === "awaiting"
                ? state.bookingDraft
                : reduceBookingDraft(state.bookingDraft, {
                    type: "note_status",
                    status: "awaiting",
                  }),
            }
          : { bookingNoteStatus: "awaiting" as const }
        : {};
    const offeredService =
      (agent.id === BOOKING_AGENT_ID || agent.id === FAQ_AGENT_ID)
        ? offeredServiceForReply(state, replyText)
        : null;
    const bookingDraftForHandoff = offeredService
      && state.bookingDraft?.serviceAcceptance?.status !== "accepted"
      ? reduceBookingDraft(state.bookingDraft, {
          type: "service_selected",
          service: offeredService,
          accepted: false,
        })
      : undefined;
    const bookingDraftOfferUpdate = bookingDraftForHandoff
      ? { bookingDraft: bookingDraftForHandoff }
      : {};

    const replyMessage =
      replyText !== extractMessageTextContent(tagged.content).trim()
        || accidentalButtons.length > 0
        || yieldTag
        || slotOffer != null
        ? new AIMessage({
            content: replyText,
            additional_kwargs: tagged.additional_kwargs,
            response_metadata: tagged.response_metadata,
          })
        : tagged;

    const lastHandoff = {
      agentId: agent.id,
      agentName: agent.name,
      status,
      ...(replyText.length > 0 ? { replyText } : {}),
      ...(replyButtons.length > 0 ? { replyButtons } : {}),
      ...(yieldFlag ? { yieldToSupervisor: true } : {}),
    };
    if (status === "empty") {
      return { ...cleared, lastHandoff, ...noteStatusForHandoff, ...bookingDraftOfferUpdate };
    }

    if (status === "max_steps") {
      if (replyText.length === 0) {
        console.error(
          `[clinic-${agent.id}] exceeded the maximum of ${agent.maxSteps} tool steps.`,
        );
      }
      return {
        ...cleared,
        lastHandoff,
        ...noteStatusForHandoff,
        ...bookingDraftOfferUpdate,
        messages: [
          replyText.length > 0
            ? replyMessage
            : tagRuntimeAgentMessage(new AIMessage(PATIENT_FALLBACK_MESSAGE), agent.id),
        ],
      };
    }

    return {
      ...cleared,
      lastHandoff,
      ...noteStatusForHandoff,
      ...bookingDraftOfferUpdate,
      messages: [replyMessage],
    };
  };

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
  commandPrepareName?: string,
): string => {
  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  // Replacement consent is a runtime-owned transition. Do not let a model
  // retry create_meeting or answer with the same menu instead of dispatching
  // the cancellation command.
  if (commandPrepareName && replacementActionForTurn(state) != null) {
    return commandPrepareName;
  }

  // Once the draft is complete, the runtime owns command preparation. This
  // prevents an LLM mutation retry/error from becoming the booking state
  // machine and also supports a model response containing plain text.
  if (commandPrepareName && bookingDraftCanPrepareCommand(state)) {
    return commandPrepareName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    if (commandPrepareName) {
      return commandPrepareName;
    }
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
  mutationFinalizeName?: string,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  if (mutationFinalizeName && terminalCancellationOutcome(state) != null) {
    return mutationFinalizeName;
  }

  return llmName;
};

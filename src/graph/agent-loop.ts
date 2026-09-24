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
  tryAvailabilityCacheHit,
  KYIV_LOCAL_ISO_SCHEMA,
  presentAvailabilitySlotsArgsSchema,
  type AvailabilityContext,
  type AvailabilitySlotsToolArgs,
} from "../tools/availability-tools.js";
import { formatKyivDayLabel, kyivToday, shortDayMonthLabel } from "../tools/availability-slots.js";
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
  patientAgreedToConsultation,
  stripLeakedModelToolCalls,
} from "../shared/message-content.js";
import { normalizeClinicPhone } from "../shared/phone.js";
import {
  formatBookingMeetingsContext,
  formatContactContext,
  formatPlannedVisitsFlag,
  formatSelectedSlotContext,
  formatServicesContext,
} from "./context-blocks.js";
import {
  buildCachedMessages,
  buildUncachedMessages,
} from "./gemini-cache-messages.js";
import type { ClinicState, ClinicStateUpdate } from "./state.js";
import {
  isModelFailureMessage,
  tagModelFailureMessage,
  tagRuntimeAgentMessage,
} from "./sub-agent-messages.js";

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;
export const llmNodeName = (agentId: string): string => `${agentId}__llm`;
export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;
export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

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
  messages: BaseMessage[],
): boolean =>
  agentId === BOOKING_AGENT_ID
  && CONSULTATION_AGREEMENT_TOOLS.has(call.name)
  && toolCallServiceId(call) === CONSULTATION_SERVICE_ID
  && !patientAgreedToConsultation(messages);

const BLOCKED_MEETING_ERRORS = new Set([
  "Contact incomplete",
  "Already booked",
  "Not authorized",
  "Note step required",
  CREATE_CONSULTATION_REQUIRED_ERROR,
]);

export type MeetingMutationOutcome = "committed" | "pending" | "blocked" | "failed" | null;

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
  if (record.cancelled === true || record.awaitingConfirmation === true) {
    return "pending";
  }
  if (typeof record.error === "string") {
    return BLOCKED_MEETING_ERRORS.has(record.error) ? "blocked" : "failed";
  }
  return "committed";
};

const meetingMutationIsHitlDecline = (message: ToolMessage): boolean =>
  MEETING_MUTATION_TOOLS.has(message.name ?? "")
  && asJsonRecord(extractMessageTextContent(message.content).trim())?.cancelled === true;

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

type AvailabilitySearchDirection = NonNullable<AvailabilitySlotsToolArgs["direction"]>;

const EARLIER_SEARCH_RE =
  /(?:раніш|раньше|скоріш|ближч(?:а|у|ий|е)\s+(?:дата|date)|earlier|sooner|earliest)/i;
const LATER_SEARCH_RE =
  /(?:пізніш|позніш|далі|коли\s+ще|інші?\s+дат|позже|когда\s+ещ[её]|друг(?:ая|ую|ие|ой)\s+(?:дат[ауые]|день|дни)|later|next|when\s+else|another\s+date)/i;

const isEarlierAvailabilityHuman = (humanText: string): boolean =>
  EARLIER_SEARCH_RE.test(humanText.trim());

const isLaterAvailabilityHuman = (humanText: string): boolean =>
  isOtherDateHuman(humanText) || LATER_SEARCH_RE.test(humanText.trim());

const firstSnapshotDate = (
  ctx: AvailabilityContext | null | undefined,
): string | undefined => ctx?.days[0]?.date;

const lastSnapshotDate = (
  ctx: AvailabilityContext | null | undefined,
): string | undefined => ctx?.days.at(-1)?.date;

const availabilityDirectionFromRequest = (
  args: AvailabilitySlotsToolArgs,
  humanText: string,
  ctx: AvailabilityContext | null | undefined,
): AvailabilitySearchDirection => {
  const explicit = resolveAvailabilityRequest(humanText, kyivToday());
  if (explicit?.kind === "exact" && matchAvailabilityDay(humanText, ctx?.days ?? []) == null) {
    return "exact";
  }
  if (isEarlierAvailabilityHuman(humanText)) {
    return "earlier";
  }
  if (isLaterAvailabilityHuman(humanText)) {
    return "later";
  }
  if (args.direction) {
    return args.direction;
  }
  if (args.date) {
    return "exact";
  }
  if (!ctx) {
    return "nearest";
  }
  return ctx.searchDirection === "exact" ? "later" : "nearest";
};

const lastOpenSnapshotDate = (
  ctx: AvailabilityContext | null | undefined,
): string | undefined => {
  const open = ctx?.days.filter((day) => day.slots.length > 0) ?? [];
  return open.at(-1)?.date;
};

const bookingDateAnchors = (state: ClinicState): string[] => [
  ...(state.selectedSlot
    ? [state.selectedSlot.dateStart, state.selectedSlot.dateEnd]
    : []),
  ...(state.availabilityContext?.days ?? []).map((day) => day.date),
];

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
      : isEarlierAvailabilityHuman(human)
        ? "earlier"
        : isLaterAvailabilityHuman(human)
          ? "later"
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
  for (const day of availabilityContext.days) {
    for (const slot of day.slots) {
      const labelNorm = slot.label.trim().toLowerCase().replace(/\s+/g, "");
      if (normalized === labelNorm || (wantClock != null && clockKey(labelNorm) === wantClock)) {
        return { dateStart: slot.dateStart, dateEnd: slot.dateEnd, label: slot.label };
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
  const status = state.bookingNoteStatus ?? "unasked";
  const availability = state.availabilityContext;
  const matchedSlot = matchAvailabilitySlot(human, availability);
  const matchedDay = matchAvailabilityDay(human, availability?.days ?? []);

  const sameSlot =
    matchedSlot != null
    && state.selectedSlot != null
    && state.selectedSlot.dateStart === matchedSlot.dateStart;

  if (status === "awaiting") {
    if (isNoteSkipReply(human) || sameSlot) {
      trackEvent("booking_note_step", { phase: "skipped" });
      return { bookingNoteStatus: "skipped" };
    }
    if (matchedSlot) {
      trackEvent("booking_note_step", { phase: "awaiting" });
      return { bookingNoteStatus: "awaiting", selectedSlot: matchedSlot };
    }
    if (matchedDay) {
      return { bookingNoteStatus: "unasked", selectedSlot: null };
    }
    trackEvent("booking_note_step", { phase: "answered" });
    return { bookingNoteStatus: "answered" };
  }

  if (matchedSlot && (status === "unasked" || !sameSlot)) {
    trackEvent("booking_note_step", { phase: "awaiting" });
    return { bookingNoteStatus: "awaiting", selectedSlot: matchedSlot };
  }

  if (matchedDay && (status === "skipped" || status === "answered")) {
    return { bookingNoteStatus: "unasked", selectedSlot: null };
  }

  return {};
};

const resetBookingNoteState = (): ClinicStateUpdate => ({
  bookingNoteStatus: "unasked",
  selectedSlot: null,
});

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
      Object.assign(update, advanceBookingNoteStep(state));
    }
    return update;
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
    // After a time pick, pass only the matched ISO slot for create_meeting.
    if (agent.id === BOOKING_AGENT_ID) {
      dynamicParts.push(formatSelectedSlotContext(state.selectedSlot));
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
          && noteStepBlocksCreate(state.bookingNoteStatus)
        ) {
          noteStatusUpdate = { bookingNoteStatus: "awaiting" };
          trackEvent("booking_create_blocked_note", {
            phase: state.bookingNoteStatus ?? "unasked",
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
          blocksConsultationWithoutAgreement(agentId, call, [
            ...state.messages,
            ...agentMessages,
          ])
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
          call.args = { ...(call.args ?? {}) };
          const args = call.args as { dateStart?: string; dateEnd?: string };
          if (call.name === "create_meeting" && state.selectedSlot) {
            args.dateStart = state.selectedSlot.dateStart;
            args.dateEnd = state.selectedSlot.dateEnd;
          } else {
            alignArgDates(args, ["dateStart", "dateEnd"], bookingDateAnchors(state));
          }
          if (
            (call.name === "reschedule_meeting" || state.selectedSlot == null)
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
                    "Use YYYY-MM-DDTHH:mm:ss from <selected_slot> or present_availability_slots.",
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
          call.args = { ...(call.args ?? {}) };
          const args = call.args as AvailabilitySlotsToolArgs;
          const lastOpen = lastOpenSnapshotDate(state.availabilityContext);
          const human = lastPatientText(state);
          const consultationAccepted = isConsultationOfferAcceptance(state);
          const direction = consultationAccepted
            ? "nearest"
            : availabilityDirectionFromRequest(args, human, state.availabilityContext);
          const explicitRequest = resolveAvailabilityRequest(human, kyivToday());
          const pickedOfferedDay = matchAvailabilityDay(
            human,
            state.availabilityContext?.days ?? [],
          );
          const directionalRequest = direction === "earlier" || direction === "later";
          if (consultationAccepted) {
            // A positive answer to the consultation offer is a new DATE action.
            // Do not carry an exact-date cursor from an earlier conversation turn.
            args.direction = "nearest";
            delete args.date;
            delete args.afterDate;
            delete args.beforeDate;
            delete args.startDate;
          } else if (directionalRequest && availabilityPagedThisTurn) {
            delete args.afterDate;
            delete args.beforeDate;
            delete args.date;
            delete args.startDate;
            args.direction = state.availabilityContext?.searchDirection ?? direction;
          } else if (direction === "earlier") {
            args.direction = "earlier";
            const earlierAnchor =
              state.availabilityContext?.searchedFrom
              ?? firstSnapshotDate(state.availabilityContext)
              ?? kyivToday();
            args.beforeDate = earlierAnchor;
            delete args.afterDate;
            delete args.startDate;
            delete args.date;
          } else if (direction === "later") {
            args.direction = "later";
            const laterAnchor =
              state.availabilityContext?.searchedThrough
              ?? lastOpen
              ?? lastSnapshotDate(state.availabilityContext);
            if (laterAnchor) {
              args.afterDate = laterAnchor;
            } else {
              delete args.afterDate;
            }
            delete args.beforeDate;
            delete args.startDate;
            delete args.date;
          } else if (direction === "exact") {
            args.direction = "exact";
            if (explicitRequest?.kind === "exact" && pickedOfferedDay == null) {
              args.date = explicitRequest.date;
            }
            delete args.afterDate;
            delete args.beforeDate;
          } else {
            args.direction = "nearest";
            delete args.afterDate;
            delete args.beforeDate;
          }
          if (direction === "later" && !args.afterDate) {
            delete args.afterDate;
          }
          if (direction === "earlier" && !args.beforeDate) {
            delete args.beforeDate;
          }
          alignArgDates(
            args,
            ["date", "afterDate", "beforeDate", "startDate"],
            bookingDateAnchors(state),
          );
          if (direction === "exact" && !args.date) {
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
          if (directionalRequest) {
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
    const update: ClinicStateUpdate = {
      agentMessages: resultMessages,
      ...noteStatusUpdate,
    };

    if (meetingMutationClearsAvailability(resultMessages)) {
      update.availabilityContext = null;
      // REPLACE cancel-and-rebook: keep selectedSlot + note so create_meeting can reuse them.
      // Only skip reset when cancel_meeting is the sole committed mutation this turn.
      const committed = resultMessages.filter(
        (message): message is ToolMessage =>
          message instanceof ToolMessage
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
      const cancelOnlyCommitted =
        committed.length > 0 && committed.every((message) => message.name === "cancel_meeting");
      if (!cancelOnlyCommitted) {
        Object.assign(update, resetBookingNoteState());
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
        update.availabilityContext = capturedAvailability;
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
      && (state.bookingNoteStatus === "awaiting" || noteBlockedThisTurn)
      && !alreadyBooked;
    // Slot offer: code-own DATE/TIME from tool snapshot or day-pick against checkpoint.
    const slotOffer =
      agent.id === BOOKING_AGENT_ID && !alreadyBooked && !createCommitted
        ? resolveAvailabilityOffer(agentMessages, state.availabilityContext)
        : null;
    if (slotOffer) {
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

    const noteStatusForHandoff =
      awaitingNote && !slotOffer
        ? ({ bookingNoteStatus: "awaiting" as const } satisfies ClinicStateUpdate)
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
      return { ...cleared, lastHandoff, ...noteStatusForHandoff };
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
      messages: [replyMessage],
    };
  };

export const routeAfterAgentLlm = (
  state: ClinicState,
  maxSteps: number,
  toolsName: string,
  finalizeName: string,
): string => {
  if (state.stepCount >= maxSteps) {
    return finalizeName;
  }

  if (hasPendingToolCalls(state.agentMessages) || lastMessageRequestsTools(state.agentMessages)) {
    return toolsName;
  }

  return finalizeName;
};

export const routeAfterAgentTools = (
  state: ClinicState,
  llmName: string,
  toolsName: string,
): string => {
  if (hasPendingToolCalls(state.agentMessages)) {
    return toolsName;
  }

  return llmName;
};

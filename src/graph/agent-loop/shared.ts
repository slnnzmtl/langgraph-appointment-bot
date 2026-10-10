import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type BookingNoteStatus,
  type SelectedBookingSlot,
} from "../types.js";
import {
  normalizePresentAvailabilityResult,
  availabilityQueryFromContext,
  type AvailabilityContext,
} from "../../tools/availability-tools.js";
import {
  kyivToday,
  shortDayMonthLabel,
} from "../../tools/availability-slots.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import { normalizeListServicesResult, type ServicesContext } from "../../tools/service-tools.js";
import { trackEvent } from "../../analytics/track.js";
import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  CONSULTATION_SERVICE_ID,
  CLINIC_SLOT_MINUTES,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
} from "../../shared/clinic-constants.js";
import { asJsonRecord, committedMeetingEntityId } from "../../shared/json-record.js";
import {
  extractMessageTextContent,
  extractRawMessageText,
  labelIdFor,
  matchesReplyLabel,
  requestsConsultation,
} from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { getTelegramUserId } from "../../tools/telegram-user-context.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  reduceBookingDraft,
  type BookingDraft,
  type BookingService,
  type ReplacementMeeting,
} from "../booking-draft.js";
import {
  interpretInteractionReply,
  reduceBookingSession,
  type DateSelectInteraction,
  type InteractionChoice,
  type TimeSelectInteraction,
} from "../booking-session.js";
import {
  availabilityDateHeading,
  buildDateSelectInteraction,
  buildEmptyAvailabilityInteraction,
  buildTimeSelectInteraction,
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../booking-interaction-render.js";
import { buildFaqCatalogChoices, shortenFaqChoiceLabels } from "../faq-catalog.js";
import {
  partitionRemainingServiceChoices,
  type PartitionServiceCandidates,
} from "../service-resolution.js";

/** CRM writes that invalidate checkpointed contact/meetings prefetch. */
const PREFETCH_INVALIDATING_TOOLS = new Set([
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

export const MEETING_MUTATION_TOOLS = new Set([
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

/** Browse shortcuts that open catalog chips even when list_services is reused. */
export const FAQ_CATALOG_SHORTCUT_LABELS = new Set<string>([
  BOOKING_OFFER_MENU[1],
  BOOKING_OFFER_MENU_EN[1],
]);

/** Services-guide taps: consultation offer, not catalog drill-down chips. */
export const FAQ_SERVICES_GUIDE_LABELS = new Set<string>([
  DEFAULT_MENU_NO_VISITS[1],
  DEFAULT_MENU_HAS_VISITS[1],
  "Services",
]);

export const CREATE_CONSULTATION_REQUIRED_ERROR = "Consultation agreement required";

export const SLOT_SELECTION_REQUIRED_ERROR = "Availability slot selection required";

export const SELECTED_SLOT_NOT_AVAILABLE_ERROR = "Selected slot is no longer available";

export const RESCHEDULE_STATE_REQUIRED_ERROR = "Reschedule state required";

export const CONTACT_OWNERSHIP_REQUIRED_ERROR = "Contact ownership required";

export const CONTACT_LINK_CANDIDATE_REQUIRED_ERROR = "Contact link candidate required";

const CONSULTATION_AGREEMENT_TOOLS = new Set(["create_meeting", "reschedule_meeting"]);

const toolCallServiceId = (call: { args?: unknown }): string | null => {
  const args = call.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const serviceId = (args as { serviceId?: unknown }).serviceId;
  return typeof serviceId === "string" ? serviceId : null;
};

export const blocksConsultationWithoutAgreement = (
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
  RESCHEDULE_STATE_REQUIRED_ERROR,
  CONTACT_OWNERSHIP_REQUIRED_ERROR,
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
]);

/** Mutation success is runtime-owned; model prose can never prove a CRM write. */
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
    return "failed";
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
  return committedMeetingEntityId(body) != null ? "committed" : "failed";
};

export const meetingMutationIsHitlDecline = (message: ToolMessage): boolean =>
  MEETING_MUTATION_TOOLS.has(message.name ?? "")
  && asJsonRecord(extractMessageTextContent(message.content).trim())?.cancelled === true;

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
      || outcome === "pending_confirmation"
    ) {
      return true;
    }
  }
  const draft = state.bookingDraft;
  if (draft != null) {
    if (draft.phase === "details" || draft.phase === "confirming" || draft.pendingCommand != null) {
      return true;
    }
  }
  return state.pendingInteraction?.kind === "mutation_confirm";
};

export const terminalMeetingMutationOutcome = (state: ClinicState): ToolMessage | null => {
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof ToolMessage) || !MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
      continue;
    }
    const outcome = classifyMeetingMutationToolMessage(message);
    if (message.name !== "cancel_meeting") {
      const record = asJsonRecord(extractMessageTextContent(message.content).trim());
      const isReplacementConflict = record?.error === "Already booked";
      const isInvariantGuard = record?.error === CREATE_CONSULTATION_REQUIRED_ERROR;
      if (!isReplacementConflict && (isInvariantGuard || outcome === "committed" || outcome === "declined" || outcome === "failed")) {
        return message;
      }
      continue;
    }
    // A committed replacement cancellation is a continuation, not a
    // patient-facing terminal outcome: the replacement create flow owns it.
    // Declined/failed replacement cancellation outcomes are terminal, but must
    // retain their replacement origin for the correct response/menu.
    if (state.pendingCancellationPurpose === "replacement") {
      // Failed/blocked replacement cancel must close the session — leaving
      // cancelling + originalCommand would replay a stale create later.
      return outcome === "declined" || outcome === "failed" || outcome === "blocked"
        ? message
        : null;
    }
    // Keep the legacy state guard for checkpoints created before the explicit
    // cancellation-purpose field existed.
    if (state.bookingDraft?.replacement != null) {
      return null;
    }
    if (outcome === "committed" || outcome === "declined" || outcome === "blocked" || outcome === "failed") {
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

type ContactIdentityResolution =
  | { kind: "owned"; contactId: string; contact: Record<string, unknown> }
  | { kind: "phone_candidate"; contacts: Record<string, unknown>[] }
  | { kind: "unresolved" };

/** Resolve identity from explicit lookup provenance; ambiguous legacy context fails closed. */
export const resolveContactIdentity = (
  context: ClinicState["contactContext"],
  expectedContactId?: string | null,
): ContactIdentityResolution => {
  if (!context) {
    return { kind: "unresolved" };
  }
  const contacts = context.contacts.filter(
    (contact) => typeof contact.id === "string" && contact.id.length > 0,
  );
  if (context.ownership === "phone") {
    return contacts.length > 0
      ? { kind: "phone_candidate", contacts }
      : { kind: "unresolved" };
  }
  if (context.ownership !== "telegram") {
    return { kind: "unresolved" };
  }
  const contact = expectedContactId == null
    ? contacts[0]
    : contacts.find((candidate) => candidate.id === expectedContactId);
  return contact && typeof contact.id === "string"
    ? { kind: "owned", contactId: contact.id, contact }
    : { kind: "unresolved" };
};

export const phoneCandidateCanBeLinked = (
  identity: ContactIdentityResolution,
  contactId: string,
): boolean => {
  if (identity.kind !== "phone_candidate") {
    return false;
  }
  const candidate = identity.contacts.find((contact) => contact.id === contactId);
  if (!candidate) {
    return false;
  }
  const linkedTelegram = candidate.cTelegram;
  if (linkedTelegram == null || (typeof linkedTelegram === "string" && linkedTelegram.trim() === "")) {
    return true;
  }
  try {
    return linkedTelegram === getTelegramUserId();
  } catch {
    // Without the runtime identity, fail closed rather than overwrite a link.
    return false;
  }
};

export const phoneCandidateHasLinkableRow = (identity: ContactIdentityResolution): boolean =>
  identity.kind === "phone_candidate"
  && identity.contacts.some(
    (contact) => typeof contact.id === "string" && phoneCandidateCanBeLinked(identity, contact.id),
  );

/** True when create_contact's phone matches a stored phone candidate that cannot be linked. */
export const createContactPhoneMatchesOccupiedCandidate = (
  identity: ContactIdentityResolution,
  rawPhone: unknown,
): boolean => {
  if (identity.kind !== "phone_candidate" || typeof rawPhone !== "string" || rawPhone.trim() === "") {
    return false;
  }
  const wanted = normalizeClinicPhone(rawPhone);
  if (wanted == null) {
    return false;
  }
  return identity.contacts.some((contact) => {
    if (typeof contact.id !== "string" || phoneCandidateCanBeLinked(identity, contact.id)) {
      return false;
    }
    const candidatePhone = typeof contact.phoneNumber === "string"
      ? normalizeClinicPhone(contact.phoneNumber)
      : null;
    return candidatePhone === wanted;
  });
};

const latestMeetingMutationError = (messages: BaseMessage[]): string | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !(message instanceof ToolMessage)
      || (!MEETING_MUTATION_TOOLS.has(message.name ?? "")
        && message.name !== "link_telegram_to_contact")
    ) {
      continue;
    }
    const record = asJsonRecord(extractMessageTextContent(message.content).trim());
    return typeof record?.error === "string" ? record.error : undefined;
  }
  return undefined;
};

export const bookingMutationNeedsModelRecovery = (state: ClinicState): boolean => {
  const error = latestMeetingMutationError(state.agentMessages ?? []);
  return error === "Contact incomplete"
    || error === CONTACT_OWNERSHIP_REQUIRED_ERROR
    || error === CONTACT_LINK_CANDIDATE_REQUIRED_ERROR
    || error === "Not authorized";
};

/** True when a ToolMessage for this tool is already in the current agent turn. */
export const toolRanThisTurn = (messages: BaseMessage[], toolName: string): boolean =>
  messages.some(
    (message) => message instanceof ToolMessage && toolMessageName(message) === toolName,
  );

/** Index of the latest pending_confirmation mutation ToolMessage, or -1. */
const latestPendingConfirmationIndex = (messages: BaseMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message instanceof ToolMessage
      && classifyMeetingMutationToolMessage(message) === "pending_confirmation"
    ) {
      return index;
    }
  }
  return -1;
};

/**
 * True when present_availability_slots ran after the latest awaitingConfirmation
 * mutation (or anywhere on the tape when there is no pending confirmation).
 * Pre-HITL leftover slots must not block coerce or TIME overlay.
 */
export const availabilitySlotsRanThisTurn = (messages: BaseMessage[]): boolean => {
  const start = latestPendingConfirmationIndex(messages) + 1;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message instanceof ToolMessage
      && toolMessageName(message) === "present_availability_slots"
    ) {
      return true;
    }
  }
  return false;
};

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

/** Heading for a DATE page, derived from the runtime-owned search query. */
export const formatAvailabilityHeading = (context: AvailabilityContext): string => {
  const query = availabilityQueryFromContext(context);
  const anchor = query?.kind === "later" || query?.kind === "earlier"
    ? query.anchor
    : undefined;
  return availabilityDateHeading(query?.kind, anchor);
};

const renderedAvailabilityOffer = (
  interaction: DateSelectInteraction | TimeSelectInteraction,
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction | TimeSelectInteraction } => ({
  replyText: String(renderBookingInteractionMessage(interaction).content),
  replyButtons: replyButtonsForInteraction(interaction),
  interaction,
});

/** DATE offer from a multi-day availability snapshot (code-owned when the model invents hours). */
export const formatAvailabilityDateOffer = (
  contextOrDays: AvailabilityContext | AvailabilityContext["days"],
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction } => {
  const context: AvailabilityContext = Array.isArray(contextOrDays)
    ? { days: contextOrDays, stepMinutes: CLINIC_SLOT_MINUTES }
    : contextOrDays;
  const interaction = buildDateSelectInteraction(context);
  return { ...renderedAvailabilityOffer(interaction), interaction };
};

/** TIME offer from a single-day availability snapshot. */
export const formatAvailabilityTimeOffer = (
  day: AvailabilityContext["days"][number],
  context?: AvailabilityContext,
): { replyText: string; replyButtons: string[]; interaction: TimeSelectInteraction } => {
  const availability: AvailabilityContext = context ?? {
    days: [day],
    stepMinutes: CLINIC_SLOT_MINUTES,
  };
  const interaction = buildTimeSelectInteraction(availability, day);
  return { ...renderedAvailabilityOffer(interaction), interaction };
};

export const formatAvailabilityEmptyOffer = (
  context: AvailabilityContext,
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction } => {
  const interaction = buildEmptyAvailabilityInteraction(context);
  return { ...renderedAvailabilityOffer(interaction), interaction };
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

export const lastPatientText = (state: ClinicState): string =>
  lastHumanText(state.messages) || lastHumanText(state.agentMessages ?? []);

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

export const bookingDateAnchors = (state: ClinicState): string[] => [
  ...(state.bookingDraft?.selectedDate ? [state.bookingDraft.selectedDate] : []),
  ...(state.bookingDraft?.selectedSlot
    ? [state.bookingDraft.selectedSlot.dateStart, state.bookingDraft.selectedSlot.dateEnd]
    : []),
  ...(state.availabilityContext?.days ?? []).map((day) => day.date),
  ...(state.availabilityCursor
    ? [
      state.availabilityCursor.firstDate,
      state.availabilityCursor.lastDate,
      state.availabilityCursor.query?.rangeFrom,
      state.availabilityCursor.query?.rangeThrough,
    ].filter((date): date is string => date != null)
    : []),
];

export const authoritativeSelectedSlot = (state: ClinicState): SelectedBookingSlot | null =>
  state.bookingDraft?.selectedSlot ?? null;

export const authoritativeNoteStatus = (state: ClinicState): BookingNoteStatus =>
  state.bookingDraft?.note.status ?? "unasked";

export const consultationService = (source: "catalog" | "direct"): {
  id: string;
  name: string;
  source: "catalog" | "direct";
} => ({
  id: CONSULTATION_SERVICE_ID,
  name: "Консультація",
  source,
});

/** Min length so tiny taps like «1» do not steal an offer keyboard or resume. */
const FAQ_CATALOG_NAME_MIN_LEN = 3;

/**
 * CRM rows whose names match free-text (brand/family/full title). Shared by
 * offeredServiceForTurn (first hit) and post-offer catalog resume (all ids).
 */
export const matchingCatalogRows = (
  text: string,
  services: ServicesContext["list"],
): ServicesContext["list"] => {
  const normalized = text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (
    normalized.length < FAQ_CATALOG_NAME_MIN_LEN
    || normalized.includes("?")
  ) {
    return [];
  }
  return services.filter((row) => {
    const name = row.name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    return (
      normalized === name
      || name.includes(normalized)
      || normalized.includes(name)
    );
  });
};

const catalogServiceForText = (
  text: string,
  state: ClinicState,
): { id: string; name: string; durationMinutes?: number; source: "catalog" } | null => {
  const service = matchingCatalogRows(text, state.servicesContext?.list ?? [])[0];
  if (service == null) {
    return null;
  }
  return {
    id: service.id,
    name: service.name,
    ...(service.duration != null ? { durationMinutes: service.duration } : {}),
    source: "catalog",
  };
};

/**
 * Resolve explicit service acceptance into a durable draft for this turn.
 * Direct consultation requests still accept immediately. Offer taps and dated
 * continuations go through pendingInteraction (service_confirm) when open.
 */
export const bookingDraftForTurn = (state: ClinicState): BookingDraft | null | undefined => {
  const humanMessages = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  );
  const current = humanMessages.at(-1);
  if (!current) {
    return undefined;
  }
  const currentText = extractMessageTextContent(current.content).trim();
  if (requestsConsultation(currentText)) {
    return reduceBookingDraft(state.bookingDraft, {
      type: "service_selected",
      service: consultationService("direct"),
      accepted: true,
      turn: state.stepCount,
    });
  }

  const interaction = state.pendingInteraction;
  if (interaction?.kind === "service_confirm") {
    const choice = interpretInteractionReply(interaction, currentText);
    if (choice.kind === "choice" && choice.choiceId === "accept") {
      const reduced = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: interaction,
        },
        { type: "interaction_choice", choiceId: "accept" },
      );
      return reduced.bookingDraft;
    }
    const isAvailabilityContinuation =
      resolveBookingScheduleRequest(currentText, kyivToday()) != null
      || /\b\d{1,2}(?::\d{2})?\b/.test(currentText);
    if (isAvailabilityContinuation) {
      const schedule = resolveBookingScheduleRequest(currentText, kyivToday());
      if (schedule?.kind === "exact" && schedule.date != null) {
        const reduced = reduceBookingSession(
          {
            bookingDraft: state.bookingDraft ?? null,
            pendingInteraction: interaction,
          },
          {
            type: "service_confirm_schedule",
            schedule: { type: "date_selected", date: schedule.date },
            turn: state.stepCount,
          },
        );
        return reduced.bookingDraft;
      }
      const reduced = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: interaction,
        },
        { type: "interaction_choice", choiceId: "accept" },
      );
      return reduced.bookingDraft;
    }
    return undefined;
  }

  return undefined;
};

/**
 * Resolve which CRM service a specialist is offering this turn without reading
 * offer-question wording. Prefer a named catalog row from the latest human line;
 * otherwise consultation after list_services or an explicit book/services tap.
 */
export const offeredServiceForTurn = (
  state: ClinicState,
  agentId: string,
  agentMessages: BaseMessage[],
): BookingService | null => {
  if (state.bookingDraft?.serviceAcceptance?.status === "accepted") {
    return null;
  }
  // Mid-catalog drill-down is owned by FAQ service_candidate, not a book offer.
  if (
    state.pendingInteraction?.kind === "service_candidate"
    && state.pendingInteraction.owner === "faq"
  ) {
    return null;
  }
  const lastHuman = (state.messages ?? []).filter(
    (message): message is HumanMessage => message instanceof HumanMessage,
  ).at(-1);
  const lastHumanText = lastHuman != null
    ? extractMessageTextContent(lastHuman.content).trim()
    : "";
  // «Обрати іншу процедуру» opens FAQ catalog — do not re-offer the pending peel.
  if (FAQ_CATALOG_SHORTCUT_LABELS.has(lastHumanText)) {
    return null;
  }
  if (state.bookingDraft?.serviceAcceptance?.status === "pending") {
    return state.bookingDraft.serviceAcceptance.service;
  }
  if (agentId !== FAQ_AGENT_ID && agentId !== BOOKING_AGENT_ID) {
    return null;
  }
  const service = catalogServiceForText(lastHumanText, state);
  if (service != null) {
    return service;
  }
  // «Послуги» / «Записатись» → consultation even when list_services ran this turn.
  if (
    labelIdFor(lastHumanText) === "mainBook"
    || matchesReplyLabel(lastHumanText, FAQ_SERVICES_GUIDE_LABELS)
  ) {
    return consultationService("catalog");
  }
  if (toolRanThisTurn(agentMessages, "list_services")) {
    return null;
  }
  if (requestsConsultation(lastHumanText)) {
    return consultationService("direct");
  }
  return null;
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
  const durationMinutes = state.bookingDraft?.serviceAcceptance?.service.durationMinutes;
  return {
    ...args,
    direction: args.direction ?? "nearest",
    excludeMeetingIds: [meeting.id],
    ...(durationMinutes != null ? { durationMinutes } : {}),
  };
};

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

  const human = lastPatientText(state).trim().toLocaleLowerCase();
  const ordinal = /^(\d+)$/.exec(human);
  if (ordinal && Number(ordinal[1]) <= meetings.length) {
    return meetings[Number(ordinal[1]) - 1] ?? null;
  }
  const requestedDate = resolveBookingScheduleRequest(human, kyivToday());
  const matches = meetings.filter((meeting) => {
    const name = meeting.name.toLocaleLowerCase();
    const day = meeting.dateStart.slice(0, 10);
    const dayNumber = meeting.dateStart.slice(8, 10).replace(/^0/, "");
    return human.includes(name)
      || human.includes(day)
      || (requestedDate?.kind === "exact" && requestedDate.date === day)
      || human === dayNumber;
  });
  return matches.length === 1 ? matches[0]! : null;
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
  // Telegram users often type only the day number after DATE buttons are shown.
  // Resolve it only against the trusted snapshot and only when it is unique;
  // never invent a month or silently choose between two matching months.
  const bareDay = /^(\d{1,2})$/.exec(trimmed);
  if (bareDay) {
    const wanted = Number(bareDay[1]);
    const matches = days.filter(
      (day) => day.slots.length > 0 && Number(day.date.slice(8, 10)) === wanted,
    );
    if (matches.length === 1) {
      return matches[0]!;
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
  ].map((label) => label.toLowerCase()),
);

const isNoteSkipReply = (humanText: string): boolean =>
  NOTE_SKIP_REPLIES.has(humanText.trim().toLowerCase());

export const noteStepBlocksCreate = (status: BookingNoteStatus | null | undefined): boolean =>
  status !== "skipped" && status !== "answered";

export const CREATE_NOTE_REQUIRED_ERROR = "Note step required";

export const BOOKING_SLOT_REQUIRED_UK =
  "Будь ласка, спочатку оберіть дату й час із запропонованих варіантів.";

export const PHONE_GROUNDED_TOOLS = new Set([
  "find_contact_by_phone",
  "create_contact",
  "update_contact",
]);

export const PHONE_NOT_PROVIDED_ERROR = "Phone not provided";

export const NAME_NOT_PROVIDED_ERROR = "Name not provided";

/** True when some HumanMessage in `messages` normalizes to the same E.164 as `wanted`. */
export const humanProvidedPhone = (messages: BaseMessage[], wanted: string): boolean =>
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
export const humanProvidedName = (messages: BaseMessage[], wanted: string): boolean => {
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
  const bareNumber = /^(\d{1,2})$/.exec(human.trim());
  const currentSelectedDate = state.bookingDraft?.selectedDate;
  const currentSelectedDay = currentSelectedDate == null
    ? undefined
    : availability?.days.find((day) => day.date === currentSelectedDate);
  const bareNumberIsTime = bareNumber != null
    && Number(bareNumber[1]) <= 23
    && currentSelectedDay != null
    && currentSelectedDay.slots.length > 0;
  const matchedDay = bareNumberIsTime
    ? null
    : matchAvailabilityDay(human, availability?.days ?? []);
  const explicitDate = resolveBookingScheduleRequest(human, kyivToday(), {
    availabilityContext: state.availabilityContext,
    availabilityCursor: state.availabilityCursor,
    selectedDate: state.bookingDraft?.selectedDate,
  });

  // Date intent wins over free-text note interpretation. A date outside the
  // current snapshot is still a date change, not a visit note.
  if (
    explicitDate?.kind === "exact"
    && explicitDate.date !== state.bookingDraft?.selectedDate
  ) {
    trackEvent("booking_date_selected", { date: explicitDate.date });
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "date_selected", date: explicitDate.date },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
    };
  }

  // DATE is a state transition, not just a presentation choice. Keep it until
  // the following TIME message so repeated clock labels cannot resolve against
  // another day in the same availability page.
  if (matchedDay) {
    trackEvent("booking_date_selected", { date: matchedDay.date });
    const session = reduceBookingSession(
      {
        bookingDraft: state.bookingDraft ?? null,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "date_selected", date: matchedDay.date },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
    };
  }

  // A same-message requested time is reconciled only after the exact fresh
  // availability tool result. Do not let a checkpointed snapshot or the note
  // ladder turn that intent into a stale slot/free-text note.
  if (state.bookingDraft?.requestedTime?.status === "pending") {
    return {};
  }

  const selectedDate = state.bookingDraft?.selectedDate
    ?? (authoritativeSelectedSlot(state)?.dateStart.slice(0, 10) || null);
  const availabilityMatchesService = availability == null
    || availability.serviceId == null
    || availability.serviceId === state.bookingDraft?.serviceAcceptance?.service.id;
  const matchedSlot = availabilityMatchesService
    ? matchAvailabilitySlot(human, availability, selectedDate)
    : null;

  const sameSlot =
    matchedSlot != null
    && authoritativeSelectedSlot(state) != null
    && authoritativeSelectedSlot(state)!.dateStart === matchedSlot.dateStart;

  const reduceSlotSelection = (slot: SelectedBookingSlot): {
    bookingDraft: BookingDraft | null;
    pendingInteraction: ReturnType<typeof reduceBookingSession>["pendingInteraction"];
  } | null => {
    let draft = state.bookingDraft;
    if (draft == null) {
      return null;
    }
    if (draft.selectedDate == null) {
      draft = reduceBookingDraft(draft, {
        type: "date_selected",
        date: slot.dateStart.slice(0, 10),
      });
    }
    if (draft == null) {
      return null;
    }
    const session = reduceBookingSession(
      {
        bookingDraft: draft,
        pendingInteraction: state.pendingInteraction ?? null,
      },
      { type: "slot_selected", slot },
    );
    return {
      bookingDraft: session.bookingDraft,
      pendingInteraction: session.pendingInteraction,
    };
  };

  // Rescheduling has no create-booking note/details ladder. Once the slot is
  // selected, leave all later free text to the normal booking agent flow.
  if (state.bookingDraft?.mode === "reschedule") {
    if (matchedSlot && !sameSlot) {
      trackEvent("booking_note_step", { phase: "reschedule_slot" });
      const selected = reduceSlotSelection(matchedSlot);
      return selected == null ? {} : {
        bookingDraft: selected.bookingDraft,
        pendingInteraction: selected.pendingInteraction,
      };
    }
    return {};
  }

  // Skip / same-slot reaffirm while a note is open. Free-text note answers are
  // owned by the note orchestrator (classify → reduce), not this ladder.
  if (
    (authoritativeSelectedSlot(state) != null && status === "unasked")
    || status === "awaiting"
  ) {
    if (isNoteSkipReply(human) || (status === "awaiting" && sameSlot)) {
      trackEvent("booking_note_step", { phase: "skipped" });
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        { type: "note_skipped" },
      );
      return {
        bookingDraft: session.bookingDraft,
        pendingInteraction: session.pendingInteraction,
      };
    }
    if (status === "awaiting" && matchedSlot) {
      trackEvent("booking_note_step", { phase: "awaiting" });
      const selected = reduceSlotSelection(matchedSlot);
      return selected == null ? {} : {
        bookingDraft: selected.bookingDraft,
        pendingInteraction: selected.pendingInteraction,
      };
    }
  }

  if (matchedSlot && (status === "unasked" || !sameSlot)) {
    trackEvent("booking_note_step", { phase: "awaiting" });
    const selected = reduceSlotSelection(matchedSlot);
    return selected == null ? {} : {
      bookingDraft: selected.bookingDraft,
      pendingInteraction: selected.pendingInteraction,
    };
  }

  return {};
};

export const resetBookingNoteState = (_state?: ClinicState): ClinicStateUpdate => ({});

/**
 * When present_availability_slots ran this turn, replace invented DATE/TIME copy with the
 * snapshot. Multi-day → DATE; one day → TIME. Returns null when this turn is not a slot offer.
 */
type AvailabilityOfferResult = {
  replyText: string;
  replyButtons: string[];
  interaction: DateSelectInteraction | TimeSelectInteraction;
};

export const availabilityOfferFromToolTurn = (
  messages: BaseMessage[],
): AvailabilityOfferResult | null => {
  if (!availabilitySlotsRanThisTurn(messages)) {
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
    return formatAvailabilityTimeOffer(open[0]!, captured);
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
  allowCheckpointDayPick = true,
): AvailabilityOfferResult | null => {
  const captured = captureAvailabilityFromMessages(messages);
  const context = captured ?? availabilityContext ?? null;
  const days = context?.days ?? [];
  const day = allowCheckpointDayPick
    ? matchAvailabilityDay(lastHumanText(messages), days)
    : null;
  if (day && context != null) {
    return formatAvailabilityTimeOffer(day, context);
  }
  if (day) {
    return formatAvailabilityTimeOffer(day);
  }
  return availabilityOfferFromToolTurn(messages);
};

/**
 * Re-render trusted checkpoint availability from draft phase + selectedDate.
 * Ignores the human line. Refuses when the snapshot belongs to another service.
 */
export const availabilityRecoveryOffer = (
  state: ClinicState,
): AvailabilityOfferResult | null => {
  const availability = state.availabilityContext;
  if (!availability) {
    return null;
  }
  const acceptedId = state.bookingDraft?.serviceAcceptance?.status === "accepted"
    ? state.bookingDraft.serviceAcceptance.service.id
    : undefined;
  if (
    availability.serviceId != null
    && acceptedId != null
    && availability.serviceId !== acceptedId
  ) {
    return null;
  }
  const selectedDate = state.bookingDraft?.selectedDate;
  const selectedDay = selectedDate == null
    ? undefined
    : availability.days.find((day) => day.date === selectedDate);
  if (selectedDay && selectedDay.slots.length > 0) {
    return formatAvailabilityTimeOffer(selectedDay, availability);
  }
  const open = availability.days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return formatAvailabilityEmptyOffer(availability);
  }
  return formatAvailabilityDateOffer(availability);
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
export const latestCreateMeetingError = (messages: BaseMessage[]): string | undefined => {
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

export const alreadyBookedMeetingFromMessages = (
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

export const SLOT_JUST_TAKEN_PREFIX = "На жаль, обраний час щойно зайняли.\n\n";

export const resolveFaqCatalogChoices = async (input: {
  services: ServicesContext["list"];
  remainingIds?: readonly string[];
  utterance: string;
  query?: string;
  selectedLabel?: string;
  partitionCandidates?: PartitionServiceCandidates;
}): Promise<InteractionChoice[]> => {
  const partitioned = await partitionRemainingServiceChoices({
    rows: input.services,
    ...(input.remainingIds != null ? { remainingIds: input.remainingIds } : {}),
    utterance: input.utterance,
    ...(input.query != null ? { query: input.query } : {}),
    ...(input.partitionCandidates != null
      ? { partitionCandidates: input.partitionCandidates }
      : {}),
  });
  const choices = partitioned.length > 0
    ? partitioned
    : buildFaqCatalogChoices(input.services, input.remainingIds);
  return shortenFaqChoiceLabels(
    choices,
    input.selectedLabel != null && input.selectedLabel.length > 0
      ? { selectedLabel: input.selectedLabel }
      : undefined,
  );
};

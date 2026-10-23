/**
 * Booking turn interpreter (atomic cutover).
 *
 * Deterministic path: exact offered choice ids (callback_data) + offered labels
 * + UA/EN ordinals + strict structural checks (phone shape, date/time token).
 * Free patient prose is classified by the structured LLM factory in agent-loop —
 * this module stays free of LangChain / LLM connectors.
 */

import { labelIdFor, normalizeReplyLabel } from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import type { FaqTopicHint, UnderstoodBookingTurn } from "./turn.js";

export type InterpretChoice = {
  choiceId: string;
  label?: string;
};

export type InterpretBookingTurnInput = {
  rawText: string;
  /** Exact callback_data choice id from Telegram inline button (preferred). */
  callbackChoiceId?: string;
  /** Choice ids currently offered on the draft card. */
  offeredChoiceIds?: readonly string[];
  /** Labels currently shown for offeredChoiceIds (same order when lengths match). */
  offeredChoiceLabels?: readonly string[];
  awaitingNote?: boolean;
  awaitingContactField?: "phoneNumber" | "firstName" | "lastName";
  awaitingServiceConfirm?: boolean;
  /**
   * Idle FAQ unique catalog highlight is open — «Записатись» / book-this maps to
   * book_highlighted (never consultation).
   */
  faqHighlightOpen?: boolean;
  /** Active booking requirement for structured context (not used deterministically). */
  activeRequirement?: string;
  /** Patient locale hint (uk / en). */
  locale?: "uk" | "en";
  /** Kyiv calendar date YYYY-MM-DD. */
  kyivDate?: string;
};

/** Explicit book-this prose while an idle FAQ highlight is open. */
const isBookHighlightedPhrase = (raw: string): boolean => {
  const normalized = normalizeReplyLabel(raw);
  if (normalized.length === 0) {
    return false;
  }
  return (
    /^(?:book\s+this(?:\s+one)?|book\s+it)$/iu.test(normalized)
    || /^(?:записатись|записатися|запишіть|запиши)\s+(?:на\s+)?(?:цю|цю\s+послугу|цей|неї)$/iu.test(
      normalized,
    )
    || /^(?:хочу\s+)?(?:записатись|записатися)\s+(?:на\s+)?(?:цю|неї)$/iu.test(normalized)
  );
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{1,2}:\d{2}$/;

/** Exact DEFAULT / visit / services labels even when not on the current card. */
const interpretGlobalKeyboardLabel = (
  raw: string,
  faqHighlightOpen?: boolean,
): UnderstoodBookingTurn | null => {
  const globalLabel = labelIdFor(raw);
  if (globalLabel === "mainMenu") {
    return { controlIntent: { kind: "main_menu" } };
  }
  if (globalLabel === "mainBook") {
    return faqHighlightOpen === true
      ? { serviceIntent: { kind: "book_highlighted" } }
      : { serviceIntent: { kind: "consultation" } };
  }
  if (globalLabel === "mainMyVisit") {
    return { controlIntent: { kind: "visit_status" } };
  }
  if (globalLabel === "visitCancel") {
    return { controlIntent: { kind: "visit_cancel" } };
  }
  if (globalLabel === "visitReschedule") {
    return { controlIntent: { kind: "visit_reschedule" } };
  }
  if (globalLabel === "visitDecline") {
    return { controlIntent: { kind: "hitl_no" } };
  }
  if (globalLabel === "mainServices") {
    return { serviceIntent: { kind: "catalog_browse" } };
  }
  if (globalLabel === "mainAddress") {
    return { idleFaq: { question: "address", topic: "address" } };
  }
  return null;
};

/**
 * Ukrainian / English ordinals against the current offered set only.
 * 1-based. Returns null when the text is not a bare ordinal or is out of range.
 */
export const offeredChoiceIdFromOrdinal = (
  raw: string,
  offeredChoiceIds: readonly string[],
): string | null => {
  if (offeredChoiceIds.length === 0) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  const digit = /^(\d{1,2})(?:[.)]|[-ийае]?)$/u.exec(trimmed);
  if (digit != null) {
    const index = Number(digit[1]) - 1;
    return index >= 0 && index < offeredChoiceIds.length
      ? (offeredChoiceIds[index] ?? null)
      : null;
  }
  const wordIndex: Record<string, number> = {
    first: 0,
    "1st": 0,
    перший: 0,
    перша: 0,
    перше: 0,
    second: 1,
    "2nd": 1,
    другий: 1,
    друга: 1,
    друге: 1,
    third: 2,
    "3rd": 2,
    третій: 2,
    третя: 2,
    третє: 2,
    fourth: 3,
    "4th": 3,
    четвертий: 3,
    четверта: 3,
    fifth: 4,
    "5th": 4,
    "п'ятий": 4,
    пятий: 4,
    "п'ята": 4,
  };
  const index = wordIndex[trimmed];
  if (index == null || index >= offeredChoiceIds.length) {
    return null;
  }
  return offeredChoiceIds[index] ?? null;
};

/** Match raw text to an offered label (normalized). Current offer only. */
const offeredChoiceIdFromLabel = (
  raw: string,
  offeredChoiceIds: readonly string[],
  offeredChoiceLabels: readonly string[] | undefined,
): string | null => {
  if (
    offeredChoiceLabels == null
    || offeredChoiceLabels.length === 0
    || offeredChoiceIds.length === 0
  ) {
    return null;
  }
  const normalized = normalizeReplyLabel(raw);
  if (normalized.length === 0) {
    return null;
  }
  for (let i = 0; i < offeredChoiceLabels.length; i += 1) {
    const label = offeredChoiceLabels[i];
    if (label == null) {
      continue;
    }
    if (normalizeReplyLabel(label) === normalized) {
      return offeredChoiceIds[i] ?? null;
    }
  }
  return null;
};

/**
 * Canonical kernel ids plus inbound aliases from older session builders.
 * One table — session matchers import this instead of duplicating pairs.
 */
export const CHOICE_ID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  accept: ["accept", "offer_accept"],
  offer_accept: ["accept", "offer_accept"],
  choose_other: ["choose_other", "offer_choose_other"],
  offer_choose_other: ["choose_other", "offer_choose_other"],
  skip: ["skip", "note_skip"],
  note_skip: ["skip", "note_skip"],
};

const resolveOfferedCallbackId = (
  callbackId: string,
  offeredChoiceIds: readonly string[],
): string | null => {
  if (offeredChoiceIds.includes(callbackId)) {
    return callbackId;
  }
  const aliases = CHOICE_ID_ALIASES[callbackId];
  if (aliases == null) {
    return null;
  }
  return offeredChoiceIds.find((id) => aliases.includes(id)) ?? null;
};

/** Deterministic: callback id in offered set, label, ordinal, or structural phone / token. */
export const interpretBookingTurnDeterministic = (
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  const offered = new Set(input.offeredChoiceIds ?? []);
  const offeredIds = input.offeredChoiceIds ?? [];
  const callbackId = input.callbackChoiceId?.trim();
  if (callbackId != null && callbackId.length > 0) {
    const resolved = resolveOfferedCallbackId(callbackId, offeredIds);
    if (resolved != null) {
      return interpretExactChoiceId(resolved, input);
    }
    // Fail closed: unoffered callbacks never bypass the live offered set,
    // even while awaitingServiceConfirm is open.
    return {};
  }

  const raw = input.rawText.trim();
  if (raw.length === 0) {
    return {};
  }

  // Strict structural: raw text equals an offered choice id (e.g. typed ISO date).
  // Offered chips win over global menu labels («Перенести» on visit_select).
  if (offered.has(raw)) {
    return interpretExactChoiceId(raw, input);
  }

  const fromLabel = offeredChoiceIdFromLabel(raw, offeredIds, input.offeredChoiceLabels);
  if (fromLabel != null) {
    return interpretExactChoiceId(fromLabel, input);
  }

  const fromOrdinal = offeredChoiceIdFromOrdinal(raw, offeredIds);
  if (fromOrdinal != null) {
    return interpretExactChoiceId(fromOrdinal, input);
  }

  // Global menu / visit labels win over open contact fields (no routing LLM).
  const globalWhileContact = interpretGlobalKeyboardLabel(raw, input.faqHighlightOpen);
  if (globalWhileContact != null) {
    return globalWhileContact;
  }

  // Strict structural: valid phone only. Non-phone prose → {} so the structured
  // interpreter can classify visit_cancel / handoff / etc.; format error is
  // issued only after that path finds no other intent.
  if (input.awaitingContactField === "phoneNumber") {
    const phone = normalizeClinicPhone(raw);
    if (phone != null) {
      return { contactFacts: { phoneNumber: phone } };
    }
    return {};
  }

  // Open name fields: never accept names here — structured LLM classifies free text.
  if (
    input.awaitingContactField === "firstName"
    || input.awaitingContactField === "lastName"
  ) {
    return {};
  }

  // Reply-keyboard taps on an open offer use labels, not callback ids.
  if (input.awaitingServiceConfirm === true) {
    const labelId = labelIdFor(raw);
    if (labelId === "offerAccept") {
      return { serviceIntent: { kind: "confirm_pending_service" } };
    }
    if (labelId === "offerChooseOther") {
      return { serviceIntent: { kind: "decline_pending_service" } };
    }
  }

  const globalLabelPatch = interpretGlobalKeyboardLabel(raw, input.faqHighlightOpen);
  if (globalLabelPatch != null) {
    return globalLabelPatch;
  }

  // The FAQ row uses the same original offer labels, but acceptance promotes it
  // directly to booking rather than opening another service-confirm card.
  if (input.faqHighlightOpen === true) {
    const label = labelIdFor(raw);
    if (label === "offerAccept" || isBookHighlightedPhrase(raw)) {
      return { serviceIntent: { kind: "book_highlighted" } };
    }
    if (label === "offerChooseOther") {
      return { serviceIntent: { kind: "catalog_browse" } };
    }
  }

  // Free prose is not classified here — caller must use the structured LLM.
  return {};
};

const interpretExactChoiceId = (
  choiceId: string,
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  switch (choiceId) {
    case "menu":
    case "main_menu":
      return { controlIntent: { kind: "main_menu" } };
    case "abandon":
      return { controlIntent: { kind: "abandon" } };
    case "confirm":
    case "hitl_yes":
    case "offer_accept":
    case "accept":
      if (input.awaitingServiceConfirm) {
        return { serviceIntent: { kind: "confirm_pending_service" } };
      }
      return { controlIntent: { kind: "hitl_yes" } };
    case "decline":
    case "hitl_no":
    case "offer_choose_other":
    case "choose_other":
      if (input.awaitingServiceConfirm) {
        return { serviceIntent: { kind: "decline_pending_service" } };
      }
      return { controlIntent: { kind: "hitl_no" } };
    case "note_skip":
    case "skip":
      return { note: { kind: "skip" } };
    case "visit_cancel":
      return { controlIntent: { kind: "visit_cancel" } };
    case "visit_reschedule":
      return { controlIntent: { kind: "visit_reschedule" } };
    default:
      break;
  }

  if (ISO_DATE.test(choiceId)) {
    return { scheduleIntent: { kind: "date", date: choiceId }, choice: { choiceId } };
  }
  if (HH_MM.test(choiceId) || choiceId.includes("T")) {
    return { scheduleIntent: { kind: "choice", choiceId }, choice: { choiceId } };
  }
  return { choice: { choiceId } };
};

export type BookingTurnClassification = {
  serviceIntentKind?:
    | "none"
    | "consultation"
    | "named_procedure"
    | "catalog_browse"
    | "confirm_pending_service"
    | "decline_pending_service"
    | "book_highlighted";
  serviceQuery?: string;
  /** @deprecated Ignored — CRM ids must come from catalog evidence only. */
  serviceId?: string;
  scheduleKind?: "none" | "date" | "time" | "date_and_time" | "relative" | "choice";
  scheduleDate?: string;
  scheduleTime?: string;
  relativeQueryKind?: "nearest" | "earlier" | "later";
  noteKind?: "none" | "answer" | "skip";
  noteValue?: string;
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
  informationalQuestion?: string;
  faqTopic?: FaqTopicHint;
  controlKind?:
    | "none"
    | "main_menu"
    | "abandon"
    | "human_handoff"
    | "hitl_yes"
    | "hitl_no"
    | "return_to_booking"
    | "visit_status"
    | "visit_cancel"
    | "visit_reschedule"
    | "greeting"
    | "help";
  sideQuestionKind?: "none" | "hours" | "address" | "price" | "catalog" | "other";
};

export const BOOKING_TURN_INTERPRETER_INSTRUCTION = `You extract a bounded semantic booking patch from one patient message.

Return only fields that are clearly present. Prefer none/omit over guessing.

Rules:
- Never invent a firstName or lastName from hedges like "не знаю", "невідомо", "unknown", "I don't know", jokes, or questions — omit the name field so the bot can ask again.
- When the open field is firstName or lastName and the message is clearly answering with that name (including a short 1–2 token answer), set firstName/lastName even if the token is uncommon or also an English common noun (e.g. Smoke, Apple). Apostrophes stay in the value (Дар'я, O'Brien).
- Never treat a service-change request ("Хочу змінити послугу", "change the service") as a visit note.
- A message that both books and asks price/hours/address may set serviceIntent plus sideQuestionKind/informationalQuestion.
- A question about the already-selected service (price, what it is) is informationalQuestion / faqTopic — never named_procedure or catalog_browse.
- Catalog/service browse ("show services", "do you have laser?") may set catalog_browse or faqTopic catalog.
- greeting = hello/thanks with no task. help = what can you do. Neither abandons an open booking.
- human_handoff only when the patient explicitly asks for a human/operator/admin (not for a service name that contains "оператор").
- Names only when the open field is firstName/lastName AND the message is clearly answering with that name.
- Notes only when awaiting a visit note AND the message is clearly a note (not a schedule/service/control ask).
- abandon = leave an unfinished booking wizard (date/time/phone/service steps) without writing CRM. Cancelling a listed/planned visit is visit_cancel — not abandon.
- visit_cancel = cancel an existing planned visit. visit_reschedule = move an existing visit. Ambiguous "I can't make it" without choosing cancel vs reschedule → visit_cancel so the bot can clarify.
- visit_status = read-only "what is booked".
- Ukrainian, English, and mixed language are valid.
- When context says an idle FAQ unique service highlight is open: use serviceIntentKind book_highlighted only when the patient explicitly asks to book that highlighted row (book this / записатись на цю). A separate consultation request stays consultation. Affirmations (yes/так) are not book_highlighted unless the open field is pending service confirmation.
- Do not use keyword lists; decide from meaning and the open-field context provided.`;

/** Normalize a structured LLM classification into an UnderstoodBookingTurn. */
export const normalizeBookingTurnClassification = (
  raw: BookingTurnClassification,
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  const patch: UnderstoodBookingTurn = {};

  if (raw.controlKind != null && raw.controlKind !== "none") {
    patch.controlIntent = { kind: raw.controlKind };
  }

  switch (raw.serviceIntentKind) {
    case "book_highlighted":
      if (input.faqHighlightOpen === true) {
        patch.serviceIntent = { kind: "book_highlighted" };
      }
      break;
    case "consultation":
      patch.serviceIntent = { kind: "consultation" };
      break;
    case "named_procedure":
      if (raw.serviceQuery != null) {
        // Never accept model-minted CRM ids — catalog evidence resolves later.
        patch.serviceIntent = {
          kind: "named_procedure",
          query: raw.serviceQuery,
        };
      }
      break;
    case "catalog_browse":
      patch.serviceIntent = {
        kind: "catalog_browse",
        ...(raw.serviceQuery != null ? { query: raw.serviceQuery } : {}),
      };
      break;
    case "confirm_pending_service":
      if (input.awaitingServiceConfirm === true) {
        patch.serviceIntent = { kind: "confirm_pending_service" };
      }
      break;
    case "decline_pending_service":
      patch.serviceIntent = { kind: "decline_pending_service" };
      break;
    default:
      break;
  }

  switch (raw.scheduleKind) {
    case "date":
      if (raw.scheduleDate != null) {
        patch.scheduleIntent = { kind: "date", date: raw.scheduleDate };
      }
      break;
    case "time":
      if (raw.scheduleTime != null) {
        patch.scheduleIntent = { kind: "time", time: raw.scheduleTime };
      }
      break;
    case "date_and_time":
      if (raw.scheduleDate != null && raw.scheduleTime != null) {
        patch.scheduleIntent = {
          kind: "date_and_time",
          date: raw.scheduleDate,
          time: raw.scheduleTime,
        };
      }
      break;
    case "relative":
      if (raw.relativeQueryKind != null) {
        patch.scheduleIntent = { kind: "relative", queryKind: raw.relativeQueryKind };
      }
      break;
    default:
      break;
  }

  // Explicit booking start may carry compound name/note facts in the same turn.
  const explicitBookingStart =
    raw.serviceIntentKind === "consultation"
    || raw.serviceIntentKind === "named_procedure"
    || (raw.serviceIntentKind === "catalog_browse" && raw.scheduleKind != null
      && raw.scheduleKind !== "none");

  // Names/notes only when the open field matches — or on an explicit book start.
  if (input.awaitingContactField === "firstName" && raw.firstName != null) {
    patch.contactFacts = { ...(patch.contactFacts ?? {}), firstName: raw.firstName };
  } else if (input.awaitingContactField === "lastName" && raw.lastName != null) {
    patch.contactFacts = { ...(patch.contactFacts ?? {}), lastName: raw.lastName };
  } else if (input.awaitingContactField === "phoneNumber" && raw.phoneNumber != null) {
    const phone = normalizeClinicPhone(raw.phoneNumber);
    if (phone != null) {
      patch.contactFacts = { ...(patch.contactFacts ?? {}), phoneNumber: phone };
    }
  } else if (raw.phoneNumber != null && input.awaitingContactField == null) {
    const phone = normalizeClinicPhone(raw.phoneNumber);
    if (phone != null) {
      patch.contactFacts = { ...(patch.contactFacts ?? {}), phoneNumber: phone };
    }
  } else if (
    explicitBookingStart
    && input.awaitingContactField == null
    && (raw.firstName != null || raw.lastName != null)
  ) {
    patch.contactFacts = {
      ...(patch.contactFacts ?? {}),
      ...(raw.firstName != null ? { firstName: raw.firstName } : {}),
      ...(raw.lastName != null ? { lastName: raw.lastName } : {}),
    };
  }

  if (input.awaitingNote === true || explicitBookingStart) {
    if (raw.noteKind === "skip") {
      patch.note = { kind: "skip" };
    } else if (raw.noteKind === "answer" && raw.noteValue != null) {
      patch.note = { kind: "answer", value: raw.noteValue };
    }
  }

  const topicFromSide = (kind: BookingTurnClassification["sideQuestionKind"]): FaqTopicHint | undefined => {
    if (kind === "hours") return "hours";
    if (kind === "address") return "address";
    if (kind === "price") return "price";
    if (kind === "catalog") return "catalog";
    if (kind === "other") return "other";
    return undefined;
  };

  if (raw.informationalQuestion != null) {
    patch.informationalQuestion = raw.informationalQuestion;
    patch.faqTopic = raw.faqTopic ?? topicFromSide(raw.sideQuestionKind) ?? "other";
  } else if (raw.sideQuestionKind === "hours") {
    patch.informationalQuestion = "hours";
    patch.faqTopic = "hours";
  } else if (raw.sideQuestionKind === "address") {
    patch.informationalQuestion = "address";
    patch.faqTopic = "address";
  } else if (raw.sideQuestionKind === "price") {
    patch.informationalQuestion = "price";
    patch.faqTopic = "price";
  } else if (raw.sideQuestionKind === "catalog") {
    patch.serviceIntent = patch.serviceIntent ?? { kind: "catalog_browse" };
  } else if (raw.sideQuestionKind === "other" && raw.informationalQuestion == null) {
    // Unrecognized informational side question — keep text if provided via faqTopic path.
    if (raw.faqTopic === "other") {
      patch.faqTopic = "other";
    }
  }

  if (raw.faqTopic != null && patch.faqTopic == null) {
    patch.faqTopic = raw.faqTopic;
  }

  // Open offer: accept / choose-other / calendar date / side question / explicit switch.
  // Vague free text must keep the confirm card (empty patch).
  if (input.awaitingServiceConfirm === true) {
    // Only accept / choose-other advance the offer. Bare named_procedure /
    // catalog invents are dropped (fail closed). Explicit switch uses choose-other.
    const okService =
      patch.serviceIntent?.kind === "confirm_pending_service"
      || patch.serviceIntent?.kind === "decline_pending_service";
    const okSchedule =
      patch.scheduleIntent?.kind === "date"
      || patch.scheduleIntent?.kind === "date_and_time";
    const hasSideQuestion = patch.informationalQuestion != null;
    if (!okService) {
      delete patch.serviceIntent;
    }
    if (!okSchedule) {
      delete patch.scheduleIntent;
    }
    delete patch.note;
    if (
      patch.serviceIntent == null
      && patch.scheduleIntent == null
      && patch.controlIntent == null
      && patch.contactFacts == null
      && !hasSideQuestion
    ) {
      return {};
    }
  }

  return patch;
};

/**
 * Booking turn interpreter (atomic cutover).
 *
 * Deterministic path: exact offered choice ids (callback_data) + strict structural
 * checks (phone shape, date/time token equal to an offered choice id).
 * Free patient prose is classified by the structured LLM factory in agent-loop —
 * this module stays free of LangChain / LLM connectors.
 */

import { labelIdFor } from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import type { UnderstoodBookingTurn } from "./turn.js";

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
  awaitingNote?: boolean;
  awaitingContactField?: "phoneNumber" | "firstName" | "lastName";
  awaitingServiceConfirm?: boolean;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{1,2}:\d{2}$/;

/** Deterministic: callback id in offered set, or structural phone / offered date-time token. */
export const interpretBookingTurnDeterministic = (
  input: InterpretBookingTurnInput,
): UnderstoodBookingTurn => {
  const offered = new Set(input.offeredChoiceIds ?? []);
  const callbackId = input.callbackChoiceId?.trim();
  if (callbackId != null && callbackId.length > 0) {
    if (!offered.has(callbackId)) {
      return {};
    }
    return interpretExactChoiceId(callbackId, input);
  }

  const raw = input.rawText.trim();
  if (raw.length === 0) {
    return {};
  }

  // Strict structural: phone shape only (never treat free text as a name/note).
  if (input.awaitingContactField === "phoneNumber") {
    const phone = normalizeClinicPhone(raw);
    if (phone != null) {
      return { contactFacts: { phoneNumber: phone } };
    }
    return {};
  }

  // Open name field: non-empty non-control text is the name (same spirit as phone).
  if (
    input.awaitingContactField === "firstName"
    || input.awaitingContactField === "lastName"
  ) {
    const labelId = labelIdFor(raw);
    if (
      labelId === "mainMenu"
      || labelId === "mainBook"
      || labelId === "mainMyVisit"
      || labelId === "visitCancel"
      || labelId === "visitReschedule"
      || labelId === "visitDecline"
    ) {
      return {};
    }
    if (input.awaitingContactField === "firstName") {
      return { contactFacts: { firstName: raw } };
    }
    return { contactFacts: { lastName: raw } };
  }

  // Strict structural: raw text equals an offered choice id (e.g. typed ISO date).
  if (offered.has(raw)) {
    return interpretExactChoiceId(raw, input);
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
      if (input.awaitingServiceConfirm) {
        return { serviceIntent: { kind: "confirm_pending_service" } };
      }
      return { controlIntent: { kind: "hitl_yes" } };
    case "decline":
    case "hitl_no":
    case "offer_choose_other":
      if (input.awaitingServiceConfirm) {
        return { serviceIntent: { kind: "decline_pending_service" } };
      }
      return { controlIntent: { kind: "hitl_no" } };
    case "note_skip":
      return { note: { kind: "skip" } };
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
    | "decline_pending_service";
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
  controlKind?:
    | "none"
    | "main_menu"
    | "abandon"
    | "human_handoff"
    | "hitl_yes"
    | "hitl_no"
    | "return_to_booking"
    | "visit_status";
  sideQuestionKind?: "none" | "hours" | "address" | "price" | "catalog";
};

export const BOOKING_TURN_INTERPRETER_INSTRUCTION = `You extract a bounded semantic booking patch from one patient message.

Return only fields that are clearly present. Prefer none/omit over guessing.

Rules:
- Never invent a firstName or lastName from hedges like "не знаю", "I don't know", jokes, or questions.
- Never treat a service-change request ("Хочу змінити послугу", "change the service") as a visit note.
- A message that both books and asks price/hours/address may set serviceIntent plus sideQuestionKind/informationalQuestion.
- Catalog/service questions ("Чи працює оператор лазера?", "do you have laser?") are catalog_browse or informationalQuestion — never human_handoff.
- human_handoff only when the patient explicitly asks for a human/operator/admin (not for a service name that contains "оператор").
- Names only when the open field is firstName/lastName AND the message is clearly answering with that name.
- Notes only when awaiting a visit note AND the message is clearly a note (not a schedule/service/control ask).
- Ukrainian, English, and mixed language are valid.
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
      patch.serviceIntent = { kind: "confirm_pending_service" };
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

  // Names/notes only when the open field matches — never from free guessing.
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
  }

  if (input.awaitingNote === true) {
    if (raw.noteKind === "skip") {
      patch.note = { kind: "skip" };
    } else if (raw.noteKind === "answer" && raw.noteValue != null) {
      patch.note = { kind: "answer", value: raw.noteValue };
    }
  }

  if (raw.informationalQuestion != null) {
    patch.informationalQuestion = raw.informationalQuestion;
  } else if (raw.sideQuestionKind === "hours") {
    patch.informationalQuestion = "hours";
  } else if (raw.sideQuestionKind === "address") {
    patch.informationalQuestion = "address";
  } else if (raw.sideQuestionKind === "price") {
    patch.informationalQuestion = "price";
  } else if (raw.sideQuestionKind === "catalog") {
    patch.serviceIntent = patch.serviceIntent ?? { kind: "catalog_browse" };
  }

  // Open offer: only accept / choose-other / calendar date may advance.
  // Free text like «яку послугу» must keep the confirm card (empty patch).
  if (input.awaitingServiceConfirm === true) {
    const okService =
      patch.serviceIntent?.kind === "confirm_pending_service"
      || patch.serviceIntent?.kind === "decline_pending_service";
    const okSchedule =
      patch.scheduleIntent?.kind === "date"
      || patch.scheduleIntent?.kind === "date_and_time";
    if (!okService) {
      delete patch.serviceIntent;
    }
    if (!okSchedule) {
      delete patch.scheduleIntent;
    }
    delete patch.note;
    delete patch.informationalQuestion;
    if (
      patch.serviceIntent == null
      && patch.scheduleIntent == null
      && patch.controlIntent == null
      && patch.contactFacts == null
    ) {
      return {};
    }
  }

  return patch;
};

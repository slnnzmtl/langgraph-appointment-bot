/**
 * Code-owned patient-text fallbacks for booking__respond.
 * Card-specific copy preferred over generic PATIENT_FALLBACK_MESSAGE when a card is open.
 */

import {
  BOOKING_OFFER_MENU,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_UK,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  SERVICE_CONFIRM_CONSULTATION_UK,
  SERVICE_CONFIRM_PROCEDURE_UK,
} from "../../shared/clinic-constants.js";
import type {
  BookingSemanticIntent,
  BookingVerifiedFacts,
  BookingViewCard,
} from "../booking-domain/decision.js";

/** Strictly code-owned safety / confirmation copy (never invent a handoff channel). */
const SAFETY_UK: Partial<Record<BookingSemanticIntent, string>> = {
  mutation_failed: "Не вдалося змінити запис. Спробуйте, будь ласка, ще раз.",
  handoff: PATIENT_FALLBACK_MESSAGE,
  confirm_create: "Підтвердіть, будь ласка, запис.",
  confirm_reschedule: "Підтвердіть, будь ласка, перенесення.",
  confirm_cancel: "Підтвердіть, будь ласка, скасування.",
  ask_phone: BOOKING_PHONE_QUESTION_UK,
  ask_first_name: "Як вас звати? Напишіть, будь ласка, ім'я.",
  ask_last_name: "Напишіть, будь ласка, прізвище.",
  ask_note: `Можете коротко описати запит або натисніть «${INTENT_SKIP_LABEL}».`,
  present_dates: "Оберіть, будь ласка, зручну дату.",
  present_times: "Оберіть, будь ласка, зручний час.",
  ask_service: "Оберіть, будь ласка, послугу зі списку.",
  confirm_service: SERVICE_CONFIRM_CONSULTATION_UK,
};

const CLARIFICATION_UK: Record<string, string> = {
  expired_confirmation:
    "Підтвердження втратило чинність. Підтвердіть ще раз після оновлення слотів.",
  phone_occupied: BOOKING_PHONE_OCCUPIED_UK,
  phone_ambiguous:
    "Знайдено кілька контактів за цим номером. Уточніть, будь ласка, у клініці.",
  contact_write_failed:
    "Не вдалося зберегти контактні дані. Спробуйте, будь ласка, трохи пізніше.",
  contact_lookup_failed:
    "Не вдалося перевірити номер. Вкажіть, будь ласка, телефон ще раз.",
};

/** Code-owned success line from verified facts only. */
export const bookingSuccessText = (facts?: BookingVerifiedFacts): string => {
  const parts: string[] = ["Готово! Запис підтверджено."];
  if (facts?.serviceName != null && facts.serviceName.trim().length > 0) {
    parts.push(facts.serviceName.trim());
  }
  if (facts?.date != null && facts.time != null) {
    parts.push(`${facts.date} о ${facts.time}`);
  } else if (facts?.date != null) {
    parts.push(facts.date);
  }
  if (facts?.address != null && facts.address.trim().length > 0) {
    parts.push(facts.address.trim());
  }
  return parts.join(" ");
};

const cardSpecificFallback = (
  card: BookingViewCard | null | undefined,
  facts?: BookingVerifiedFacts,
): string | null => {
  if (card == null) {
    return null;
  }
  switch (card.kind) {
    case "service_confirm": {
      const name = facts?.serviceName?.trim();
      if (
        card.serviceId === CONSULTATION_SERVICE_ID
        || name == null
        || name.length === 0
      ) {
        return SERVICE_CONFIRM_CONSULTATION_UK;
      }
      return SERVICE_CONFIRM_PROCEDURE_UK(name);
    }
    case "service_candidate":
      return "Оберіть, будь ласка, послугу зі списку.";
    case "date_select":
      return "Оберіть, будь ласка, зручну дату.";
    case "time_select":
      return "Оберіть, будь ласка, зручний час.";
    case "visit_note":
      return `Можете коротко описати запит або натисніть «${INTENT_SKIP_LABEL}».`;
    case "contact_field":
      if (card.field === "phoneNumber") {
        return BOOKING_PHONE_QUESTION_UK;
      }
      if (card.field === "firstName") {
        return "Як вас звати? Напишіть, будь ласка, ім'я.";
      }
      return "Напишіть, будь ласка, прізвище.";
    case "mutation_confirm":
      if (card.action === "reschedule") {
        return SAFETY_UK.confirm_reschedule ?? "Підтвердіть, будь ласка, перенесення.";
      }
      if (card.action === "cancel") {
        return SAFETY_UK.confirm_cancel ?? "Підтвердіть, будь ласка, скасування.";
      }
      return SAFETY_UK.confirm_create ?? "Підтвердіть, будь ласка, запис.";
    case "visit_select":
      return "Оберіть, будь ласка, дію зі списку.";
    case "clarification":
      return CLARIFICATION_UK[card.reason] ?? PATIENT_FALLBACK_MESSAGE;
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
};

export const bookingResponseFallback = (input: {
  intent: BookingSemanticIntent;
  facts?: BookingVerifiedFacts;
  card?: BookingViewCard | null;
  locale?: "uk" | "en";
}): string => {
  void input.locale;
  if (input.intent === "success") {
    return bookingSuccessText(input.facts);
  }
  const reason = input.facts?.clarificationReason ?? input.facts?.failureCode;
  if (input.intent === "clarification" && reason != null && CLARIFICATION_UK[reason] != null) {
    return CLARIFICATION_UK[reason]!;
  }
  if (input.intent === "mutation_failed" && input.facts?.failureCode === "phone_occupied") {
    return BOOKING_PHONE_OCCUPIED_UK;
  }
  const fromCard = cardSpecificFallback(input.card, input.facts);
  if (fromCard != null) {
    return fromCard;
  }
  if (input.intent === "confirm_service") {
    const name = input.facts?.serviceName?.trim();
    if (
      input.facts?.serviceId === CONSULTATION_SERVICE_ID
      || name == null
      || name.length === 0
    ) {
      return `${SERVICE_CONFIRM_CONSULTATION_UK} (${BOOKING_OFFER_MENU[0]} / ${BOOKING_OFFER_MENU[1]})`;
    }
    return SERVICE_CONFIRM_PROCEDURE_UK(name);
  }
  return SAFETY_UK[input.intent] ?? PATIENT_FALLBACK_MESSAGE;
};

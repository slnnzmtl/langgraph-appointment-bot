/**
 * Code-owned patient-text fallbacks for booking__respond.
 * Card-specific copy preferred over generic PATIENT_FALLBACK_MESSAGE when a card is open.
 */

import {
  BOOKING_FIRST_NAME_INVALID_UK,
  BOOKING_LAST_NAME_INVALID_UK,
  BOOKING_OFFER_MENU,
  BOOKING_PHONE_INVALID_UK,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_EN,
  BOOKING_PHONE_QUESTION_UK,
  CLINIC_ADDRESS,
  CLINIC_MAPS_MARKDOWN,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  SERVICE_CONFIRM_CONSULTATION_EN,
  SERVICE_CONFIRM_CONSULTATION_UK,
  SERVICE_CONFIRM_PROCEDURE_EN,
  SERVICE_CONFIRM_PROCEDURE_UK,
} from "../../shared/clinic-constants.js";
import type { ConversationLocale } from "../../shared/conversation-locale.js";
import { visitLabelFromCommand } from "../../tools/visit-label.js";
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
  availability_failed:
    "Не вдалося перевірити вільний час. Спробуйте, будь ласка, трохи пізніше.",
  invalid_phone: BOOKING_PHONE_INVALID_UK,
  invalid_firstName: BOOKING_FIRST_NAME_INVALID_UK,
  invalid_lastName: BOOKING_LAST_NAME_INVALID_UK,
  need_service:
    "Уточніть, будь ласка, послугу — напишіть назву або скажіть «консультація».",
  unknown_faq:
    "На жаль, я не маю цієї інформації. Можу допомогти із записом або іншими питаннями про клініку.",
  visit_cancel_ambiguous:
    "Уточніть, будь ласка: скасувати візит чи перенести на інший час?",
  visit_reschedule_ambiguous:
    "Уточніть, будь ласка, який візит перенести.",
  no_visit_to_reschedule:
    "Зараз немає запланованого візиту для перенесення.",
};

const CLARIFICATION_EN: Partial<Record<string, string>> = {
  availability_failed:
    "I could not check available times. Please try again in a moment.",
  need_service:
    "Please clarify the service — type a name or say “consultation”.",
  unknown_faq:
    "I do not have that information. I can help with booking or other clinic questions.",
  invalid_phone:
    "I could not recognize the number. Please send +380XXXXXXXXX or 0XXXXXXXXX.",
  invalid_firstName:
    "Please share your first name as one word (letters; hyphen or apostrophe is fine).",
  invalid_lastName:
    "Please share your last name as one word (letters; hyphen or apostrophe is fine).",
  contact_lookup_failed:
    "I could not verify the number. Please send your phone again.",
  contact_write_failed:
    "I could not save your contact details. Please try again in a moment.",
  phone_occupied:
    "This number is linked to another account. Please send a different number.",
};

/** Patient prose for a clarification reason, or null when unknown. */
export const clarificationCopy = (
  reason: string | undefined,
  locale: ConversationLocale = "uk",
): string | null => {
  if (reason == null) {
    return null;
  }
  if (locale === "en" && CLARIFICATION_EN[reason] != null) {
    return CLARIFICATION_EN[reason]!;
  }
  return CLARIFICATION_UK[reason] ?? null;
};

/**
 * Shared create/reschedule confirmation (booking__respond + mutation-finalize).
 * Screenshot shape: headline, Ukrainian visit label + sparkle, address + maps.
 */
export const committedCreateOrRescheduleReply = (
  verb: "створено" | "перенесено",
  visitLabel: string | undefined,
): string => {
  const headline = visitLabel != null && visitLabel.length > 0
    ? `Готово! Запис ${verb}.\n\n${visitLabel} ✨`
    : `Готово! Запис ${verb}.`;
  return `${headline}\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`;
};

/** Code-owned success copy from verified facts only. */
export const bookingSuccessText = (facts?: BookingVerifiedFacts): string => {
  if (facts?.action === "cancel") {
    return "Запис скасовано.";
  }
  const verb = facts?.action === "reschedule" ? "перенесено" : "створено";
  const serviceName = facts?.serviceName?.trim();
  const visitLabel = serviceName != null && serviceName.length > 0
    ? visitLabelFromCommand(serviceName, facts?.dateStart)
    : undefined;
  return committedCreateOrRescheduleReply(verb, visitLabel);
};

const cardSpecificFallback = (
  card: BookingViewCard | null | undefined,
  facts?: BookingVerifiedFacts,
  locale: ConversationLocale = "uk",
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
        return locale === "en"
          ? SERVICE_CONFIRM_CONSULTATION_EN
          : SERVICE_CONFIRM_CONSULTATION_UK;
      }
      return locale === "en"
        ? SERVICE_CONFIRM_PROCEDURE_EN(name)
        : SERVICE_CONFIRM_PROCEDURE_UK(name);
    }
    case "service_candidate":
      return locale === "en"
        ? "Please choose a service from the list."
        : "Оберіть, будь ласка, послугу зі списку.";
    // DATE/TIME/visit_select listed copy lives in
    // renderBookingInteractionMessage — not a second fallback writer.
    case "date_select":
    case "time_select":
    case "visit_select":
      return null;
    case "visit_note":
      return locale === "en"
        ? `You can briefly describe your request or tap «${INTENT_SKIP_LABEL}».`
        : `Можете коротко описати запит або натисніть «${INTENT_SKIP_LABEL}».`;
    case "contact_field":
      if (card.field === "phoneNumber") {
        return locale === "en"
          ? BOOKING_PHONE_QUESTION_EN
          : BOOKING_PHONE_QUESTION_UK;
      }
      if (card.field === "firstName") {
        return locale === "en"
          ? "Please share your first name."
          : "Як вас звати? Напишіть, будь ласка, ім'я.";
      }
      return locale === "en"
        ? "Please share your last name."
        : "Напишіть, будь ласка, прізвище.";
    case "mutation_confirm":
      if (card.action === "reschedule") {
        return SAFETY_UK.confirm_reschedule ?? "Підтвердіть, будь ласка, перенесення.";
      }
      if (card.action === "cancel") {
        return SAFETY_UK.confirm_cancel ?? "Підтвердіть, будь ласка, скасування.";
      }
      return SAFETY_UK.confirm_create ?? "Підтвердіть, будь ласка, запис.";
    case "clarification":
      return clarificationCopy(card.reason, locale) ?? PATIENT_FALLBACK_MESSAGE;
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
  locale?: ConversationLocale;
}): string => {
  const locale = input.locale ?? "uk";
  if (input.intent === "success") {
    return bookingSuccessText(input.facts);
  }
  const reason = input.facts?.clarificationReason ?? input.facts?.failureCode;
  // Prefer specialized reason copy over generic contact_field / ask_* prompts.
  const clarified = clarificationCopy(reason, locale);
  if (clarified != null) {
    return clarified;
  }
  if (input.intent === "mutation_failed" && input.facts?.failureCode === "phone_occupied") {
    return BOOKING_PHONE_OCCUPIED_UK;
  }
  const fromCard = cardSpecificFallback(input.card, input.facts, locale);
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
      return locale === "en"
        ? `${SERVICE_CONFIRM_CONSULTATION_EN} (${BOOKING_OFFER_MENU[0]} / ${BOOKING_OFFER_MENU[1]})`
        : `${SERVICE_CONFIRM_CONSULTATION_UK} (${BOOKING_OFFER_MENU[0]} / ${BOOKING_OFFER_MENU[1]})`;
    }
    return locale === "en"
      ? SERVICE_CONFIRM_PROCEDURE_EN(name)
      : SERVICE_CONFIRM_PROCEDURE_UK(name);
  }
  return SAFETY_UK[input.intent] ?? PATIENT_FALLBACK_MESSAGE;
};

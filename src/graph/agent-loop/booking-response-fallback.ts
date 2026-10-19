/**
 * Intent-keyed patient-text fallbacks when the response model fails.
 * Code-owned; the kernel never emits these strings.
 */

import type {
  BookingSemanticIntent,
  BookingVerifiedFacts,
} from "../booking-domain/decision.js";

const FALLBACKS_UK: Record<BookingSemanticIntent, string> = {
  ask_phone: "Надішліть, будь ласка, ваш номер телефону.",
  ask_first_name: "Вкажіть, будь ласка, ваше ім'я.",
  ask_last_name: "Вкажіть, будь ласка, ваше прізвище.",
  ask_service: "Яку послугу бажаєте записати?",
  ask_note: "Додайте примітку до візиту або пропустіть.",
  confirm_service: "Підтвердіть, будь ласка, обрану послугу.",
  present_dates: "Оберіть зручну дату.",
  present_times: "Оберіть зручний час.",
  confirm_create: "Підтвердіть, будь ласка, запис.",
  confirm_reschedule: "Підтвердіть, будь ласка, перенесення.",
  confirm_cancel: "Підтвердіть, будь ласка, скасування.",
  answer_side_question: "Ось відповідь на ваше запитання.",
  success: "Готово.",
  mutation_failed: "Не вдалося змінити запис. Спробуйте ще раз.",
  clarification: "Уточніть, будь ласка.",
  handoff: "Передаю ваш запит далі.",
  menu: "Повертаю до головного меню.",
  abandon: "Добре, скасовую запис.",
  need_interpreter: "Уточніть, будь ласка, ваш запит.",
  run_effect: "Секунду…",
  idle: "Чим ще допомогти?",
};

const CLARIFICATION_UK: Record<string, string> = {
  expired_confirmation:
    "Підтвердження втратило чинність. Підтвердіть ще раз після оновлення слотів.",
  phone_occupied:
    "Цей номер уже прив'язаний до іншого акаунта. Надішліть інший номер.",
  phone_ambiguous: "Знайдено кілька контактів за цим номером. Уточніть у клініці.",
  availability_empty: "На цей час немає вільних слотів. Оберіть іншу дату.",
  effect_id_mismatch: "Не вдалося зіставити результат дії. Уточніть, будь ласка.",
  contact_write_failed: "Не вдалося зберегти контакт. Спробуйте ще раз.",
};

export const bookingResponseFallback = (input: {
  intent: BookingSemanticIntent;
  facts?: BookingVerifiedFacts;
  locale?: "uk" | "en";
}): string => {
  const reason = input.facts?.clarificationReason;
  if (input.intent === "clarification" && reason != null && CLARIFICATION_UK[reason] != null) {
    return CLARIFICATION_UK[reason];
  }
  if (input.intent === "answer_side_question" && input.facts != null) {
    const parts = [
      input.facts.hours,
      input.facts.address,
      input.facts.servicePrice,
    ].filter((part): part is string => part != null && part.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (input.intent === "success") {
    const bits = [
      input.facts?.serviceName ?? input.facts?.serviceId,
      input.facts?.date,
      input.facts?.time,
      input.facts?.address,
    ].filter((part): part is string => part != null && String(part).trim().length > 0);
    if (bits.length > 0) {
      return `Готово: ${bits.join(", ")}.`;
    }
  }
  return FALLBACKS_UK[input.intent] ?? FALLBACKS_UK.idle;
};

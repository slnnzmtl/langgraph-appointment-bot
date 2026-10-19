/**
 * Minimal code-owned patient-text fallbacks when the response model fails.
 * Normal ask/success/side-question prose stays in the response model.
 * Date/time/service button labels come from presentation facts on the card.
 */

import {
  BOOKING_PHONE_OCCUPIED_UK,
  PATIENT_FALLBACK_MESSAGE,
} from "../../shared/clinic-constants.js";
import type {
  BookingSemanticIntent,
  BookingVerifiedFacts,
} from "../booking-domain/decision.js";

/** Generic operational line for ordinary ask/reply intents when the model fails. */
const GENERIC_FALLBACK = PATIENT_FALLBACK_MESSAGE;

/** Strictly code-owned safety / confirmation copy (never invent an handoff channel). */
const SAFETY_UK: Partial<Record<BookingSemanticIntent, string>> = {
  mutation_failed: "Не вдалося змінити запис. Спробуйте, будь ласка, ще раз.",
  handoff: PATIENT_FALLBACK_MESSAGE,
  confirm_create: "Підтвердіть, будь ласка, запис.",
  confirm_reschedule: "Підтвердіть, будь ласка, перенесення.",
  confirm_cancel: "Підтвердіть, будь ласка, скасування.",
};

const CLARIFICATION_UK: Record<string, string> = {
  expired_confirmation:
    "Підтвердження втратило чинність. Підтвердіть ще раз після оновлення слотів.",
  phone_occupied: BOOKING_PHONE_OCCUPIED_UK,
  phone_ambiguous:
    "Знайдено кілька контактів за цим номером. Уточніть, будь ласка, у клініці.",
  contact_write_failed:
    "Не вдалося зберегти контактні дані. Спробуйте, будь ласка, трохи пізніше.",
};

export const bookingResponseFallback = (input: {
  intent: BookingSemanticIntent;
  facts?: BookingVerifiedFacts;
  locale?: "uk" | "en";
}): string => {
  void input.locale;
  const reason = input.facts?.clarificationReason ?? input.facts?.failureCode;
  if (input.intent === "clarification" && reason != null && CLARIFICATION_UK[reason] != null) {
    return CLARIFICATION_UK[reason];
  }
  if (input.intent === "mutation_failed" && input.facts?.failureCode === "phone_occupied") {
    return BOOKING_PHONE_OCCUPIED_UK;
  }
  return SAFETY_UK[input.intent] ?? GENERIC_FALLBACK;
};

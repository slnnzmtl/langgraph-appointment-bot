import type { BaseMessage } from "@langchain/core/messages";

import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
} from "./clinic-constants.js";
import { extractMessageTextContent } from "./message-content.js";

export type ConversationLocale = "uk" | "en";

/**
 * Detect locale from one patient line. Numeric-only / no letters → null
 * (do not flip session locale on a phone reply).
 */
export const detectLocaleFromPatientText = (
  text: string,
): ConversationLocale | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const letters = trimmed.replace(/[^A-Za-zА-Яа-яЁёІіЇїЄєҐґ]/gu, "");
  if (letters.length === 0) {
    return null;
  }
  const latin = (letters.match(/[A-Za-z]/g) ?? []).length;
  return latin / letters.length >= 0.6 ? "en" : "uk";
};

/**
 * Latin letters present and Cyrillic absent → English; otherwise Ukrainian.
 * Intended for fresh free-text book offers (not keyboard-label history scans).
 */
export const inferConversationLocaleFromText = (text: string): ConversationLocale =>
  detectLocaleFromPatientText(text) ?? "uk";

export const bookingOfferLabels = (
  locale: ConversationLocale,
): { acceptLabel: string; chooseOtherLabel: string } =>
  locale === "en"
    ? {
        acceptLabel: BOOKING_OFFER_MENU_EN[0],
        chooseOtherLabel: BOOKING_OFFER_MENU_EN[1],
      }
    : {
        acceptLabel: BOOKING_OFFER_MENU[0],
        chooseOtherLabel: BOOKING_OFFER_MENU[1],
      };

export type PatientLocaleState = {
  patientLocale?: ConversationLocale | null;
  messages?: ReadonlyArray<Pick<BaseMessage, "content"> & {
    _getType?: () => string;
  }>;
};

/**
 * Session locale for projection/composer. Prefers checkpointed patientLocale;
 * updates from the latest alphabetic human line (explicit language change).
 * Ignores numeric-only replies.
 */
export const resolvePatientLocale = (
  state: PatientLocaleState,
): ConversationLocale => {
  const messages = state.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?._getType?.() !== "human") {
      continue;
    }
    const text = extractMessageTextContent(message.content).trim();
    const detected = detectLocaleFromPatientText(text);
    if (detected != null) {
      return detected;
    }
    // Digits / empty letters: keep session locale (or uk default).
    break;
  }
  return state.patientLocale === "en" ? "en" : "uk";
};

/** Next checkpointed locale after this turn's patient text (if alphabetic). */
export const nextPatientLocale = (
  current: ConversationLocale | null | undefined,
  patientText: string,
): ConversationLocale => {
  const detected = detectLocaleFromPatientText(patientText);
  if (detected != null) {
    return detected;
  }
  return current === "en" ? "en" : "uk";
};

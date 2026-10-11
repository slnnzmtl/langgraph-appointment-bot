import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
} from "./clinic-constants.js";

export type ConversationLocale = "uk" | "en";

/**
 * Latin letters present and Cyrillic absent → English; otherwise Ukrainian.
 * Intended for fresh free-text book offers (not keyboard-label history scans).
 */
export const inferConversationLocaleFromText = (text: string): ConversationLocale => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "uk";
  }
  const hasLatin = /\p{Script=Latin}/u.test(trimmed);
  const hasCyrillic = /\p{Script=Cyrillic}/u.test(trimmed);
  return hasLatin && !hasCyrillic ? "en" : "uk";
};

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

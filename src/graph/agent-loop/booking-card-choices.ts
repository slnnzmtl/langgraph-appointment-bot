/**
 * Derive code-owned choice ids / button labels from a BookingViewCard.
 * Labels are for Telegram display only; callback_data is always the id.
 */

import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
} from "../../shared/clinic-constants.js";
import type { ConversationLocale } from "../../shared/conversation-locale.js";
import type { BookingViewCard } from "../booking-domain/decision.js";

export type BookingReplyChoice = {
  id: string;
  label: string;
};

export const choiceIdsFromCard = (card: BookingViewCard | null): string[] => {
  if (card == null) {
    return [];
  }
  switch (card.kind) {
    case "service_candidate":
      return card.choices.map((chip) => chip.id);
    case "service_confirm":
    case "date_select":
    case "time_select":
      return [...card.choiceIds];
    case "visit_note":
      return [card.skipChoiceId, "menu"];
    case "contact_field":
      return ["menu"];
    case "visit_select":
      return card.stage === "replacement"
        ? ["cancel_existing", "decline"]
        : ["menu"];
    case "mutation_confirm":
      return ["confirm", "decline", "menu"];
    case "clarification":
      return ["menu"];
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
};

/** Default chip label when card.labels / labelById omit the id. */
const defaultLabelForChoiceId = (
  id: string,
  card: BookingViewCard | null,
  locale: ConversationLocale,
): string => {
  const replace = locale === "en" ? BOOKING_REPLACE_MENU_EN : BOOKING_REPLACE_MENU;
  const offer = locale === "en" ? BOOKING_OFFER_MENU_EN : BOOKING_OFFER_MENU;
  // Visit-select decline is REPLACE «Ні, дякую», not HITL ❌.
  if (id === "decline" && card?.kind === "visit_select") {
    return replace[1];
  }
  switch (id) {
    case "confirm":
    case "hitl_yes":
      return CONFIRM_YES_LABEL;
    case "cancel_existing":
      return replace[0];
    case "decline":
    case "hitl_no":
      return CONFIRM_NO_LABEL;
    case "offer_accept":
    case "accept":
      return offer[0];
    case "offer_choose_other":
    case "choose_other":
      return offer[1];
    case "menu":
    case "main_menu":
      return MAIN_MENU_LABEL;
    case "note_skip":
    case "skip":
      return INTENT_SKIP_LABEL;
    default:
      return id;
  }
};

export const replyChoicesFromCard = (
  card: BookingViewCard | null,
  labelById?: ReadonlyMap<string, string>,
  locale: ConversationLocale = "uk",
): BookingReplyChoice[] => {
  if (card?.kind === "service_candidate") {
    return card.choices.map((chip) => ({
      id: chip.id,
      label: labelById?.get(chip.id) ?? chip.label,
    }));
  }
  const ids = choiceIdsFromCard(card);
  const cardLabels =
    card != null && "labels" in card && card.labels != null
      ? card.labels
      : undefined;
  return ids.map((id) => ({
    id,
    label: labelById?.get(id)
      ?? cardLabels?.[id]
      ?? defaultLabelForChoiceId(id, card, locale),
  }));
};

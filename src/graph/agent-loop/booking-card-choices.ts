/**
 * Derive code-owned choice ids / button labels from a BookingViewCard.
 * Labels are for Telegram display only; callback_data is always the id.
 */

import {
  BOOKING_OFFER_MENU,
  BOOKING_REPLACE_MENU,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
} from "../../shared/clinic-constants.js";
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
    case "service_confirm":
    case "service_candidate":
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

/** Default Ukrainian chip label when card.labels / labelById omit the id. */
const defaultLabelForChoiceId = (
  id: string,
  card: BookingViewCard | null,
): string => {
  // Visit-select decline is REPLACE «Ні, дякую», not HITL ❌.
  if (id === "decline" && card?.kind === "visit_select") {
    return BOOKING_REPLACE_MENU[1];
  }
  switch (id) {
    case "confirm":
    case "hitl_yes":
      return CONFIRM_YES_LABEL;
    case "cancel_existing":
      return BOOKING_REPLACE_MENU[0];
    case "decline":
    case "hitl_no":
      return CONFIRM_NO_LABEL;
    case "offer_accept":
      return BOOKING_OFFER_MENU[0];
    case "offer_choose_other":
      return BOOKING_OFFER_MENU[1];
    case "menu":
    case "main_menu":
      return MAIN_MENU_LABEL;
    case "note_skip":
      return INTENT_SKIP_LABEL;
    default:
      return id;
  }
};

export const replyChoicesFromCard = (
  card: BookingViewCard | null,
  labelById?: ReadonlyMap<string, string>,
): BookingReplyChoice[] => {
  const ids = choiceIdsFromCard(card);
  const cardLabels =
    card != null && "labels" in card && card.labels != null
      ? card.labels
      : undefined;
  return ids.map((id) => ({
    id,
    label: labelById?.get(id)
      ?? cardLabels?.[id]
      ?? defaultLabelForChoiceId(id, card),
  }));
};

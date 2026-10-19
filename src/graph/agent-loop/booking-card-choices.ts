/**
 * Derive code-owned choice ids / button labels from a BookingViewCard.
 * Labels are for Telegram display only; callback_data is always the id.
 */

import {
  BOOKING_OFFER_MENU,
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
      return ["menu"];
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
      ?? (id === "confirm" || id === "hitl_yes"
        ? CONFIRM_YES_LABEL
        : id === "decline" || id === "hitl_no"
          ? CONFIRM_NO_LABEL
          : id === "offer_accept"
            ? BOOKING_OFFER_MENU[0]
            : id === "offer_choose_other"
              ? BOOKING_OFFER_MENU[1]
              : id === "menu" || id === "main_menu"
                ? MAIN_MENU_LABEL
                : id === "note_skip"
                  ? INTENT_SKIP_LABEL
                  : id),
  }));
};

/**
 * Project BookingDecision.card → PendingInteraction without reduceBookingSession.
 * Preserves canonical card choice IDs (offer_accept, note_skip, …).
 */
import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
  SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES,
} from "../../shared/clinic-constants.js";
import {
  bookingOfferLabels,
  type ConversationLocale,
} from "../../shared/conversation-locale.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import type { BookingDraft } from "../booking-draft.js";
import type { BookingDecision, BookingViewCard } from "../booking-domain/decision.js";
import { availabilityRenderSnapshotFromContext } from "../booking-interaction-render.js";
import {
  isBookingOwnedInteraction,
  openVisitReplacementInteraction,
  type AvailabilityRenderSnapshot,
  type InteractionChoice,
  type PendingInteraction,
} from "../booking-session.js";

const choicesFromIds = (
  choiceIds: readonly string[],
  labels?: Record<string, string>,
): InteractionChoice[] =>
  choiceIds.map((id) => ({
    id,
    label: labels?.[id] ?? id,
  }));

const serviceConfirmLabels = (
  locale: ConversationLocale,
  cardLabels?: Record<string, string>,
): Record<string, string> => {
  const offer = bookingOfferLabels(locale);
  return {
    offer_accept: cardLabels?.offer_accept ?? offer.acceptLabel,
    offer_choose_other: cardLabels?.offer_choose_other ?? offer.chooseOtherLabel,
    ...cardLabels,
  };
};

const snapshotFromAvailability = (
  context: AvailabilityContext | null,
  snapshotId: string,
  dateFilter?: string,
): AvailabilityRenderSnapshot => {
  if (context == null) {
    return { snapshotId: snapshotId || "availability", days: [] };
  }
  const days = dateFilter != null
    ? context.days.filter((day) => day.date === dateFilter)
    : context.days.filter((day) => day.slots.length > 0);
  const snapshot = availabilityRenderSnapshotFromContext(context, days);
  return snapshotId.length > 0 ? { ...snapshot, snapshotId } : snapshot;
};

const projectCard = (
  card: BookingViewCard,
  draft: BookingDraft | null,
  availabilityContext: AvailabilityContext | null,
  locale: ConversationLocale,
): PendingInteraction | null => {
  switch (card.kind) {
    case "service_confirm": {
      const service = draft?.serviceAcceptance?.service;
      return {
        kind: "service_confirm",
        service: {
          id: card.serviceId,
          ...(service?.name != null ? { name: service.name } : {}),
          source: service?.source ?? "catalog",
        },
        choices: choicesFromIds(
          card.choiceIds,
          serviceConfirmLabels(locale, card.labels),
        ).map((choice) =>
          choice.id === "offer_choose_other"
            ? {
              ...choice,
              aliases: [...SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES],
            }
            : choice
        ),
      };
    }
    case "service_candidate": {
      const pending = draft?.pendingDecision;
      const catalogPending = pending?.kind === "service_candidate" ? pending : null;
      const probe = catalogPending?.query ?? "";
      return {
        kind: "service_candidate",
        utterance: probe,
        ...(catalogPending?.query != null ? { query: catalogPending.query } : {}),
        owner: "booking",
        choices: card.choices.map((chip) => ({
          id: chip.id,
          label: chip.label,
          serviceIds: [...chip.serviceIds],
          ...(chip.displayLabel != null && chip.displayLabel !== chip.label
            ? { displayLabel: chip.displayLabel }
            : {}),
        })),
      };
    }
    case "date_select": {
      const snapshot = snapshotFromAvailability(availabilityContext, card.snapshotId);
      return {
        kind: "date_select",
        snapshot: card.emptyMode != null
          ? { ...snapshot, days: [], emptyMode: card.emptyMode }
          : snapshot,
        choices: choicesFromIds(card.choiceIds, card.labels),
      };
    }
    case "time_select":
      return {
        kind: "time_select",
        date: card.date,
        snapshot: snapshotFromAvailability(
          availabilityContext,
          card.snapshotId,
          card.date,
        ),
        choices: choicesFromIds(card.choiceIds, card.labels),
      };
    case "visit_note":
      return {
        kind: "visit_note",
        choices: [
          {
            id: card.skipChoiceId,
            label: INTENT_SKIP_LABEL,
          },
          { id: "menu", label: MAIN_MENU_LABEL },
        ],
      };
    case "contact_field":
      return {
        kind: "contact_field",
        field: card.field,
        choices: [],
      };
    case "visit_select": {
      if (card.stage === "replacement" && draft?.replacement?.meeting != null) {
        return openVisitReplacementInteraction(draft.replacement.meeting);
      }
      return {
        kind: "visit_select",
        stage: card.stage,
        choices: [{ id: "menu", label: MAIN_MENU_LABEL }],
      };
    }
    case "mutation_confirm":
      return {
        kind: "mutation_confirm",
        action: card.action,
        choices: [
          { id: "confirm", label: CONFIRM_YES_LABEL },
          { id: "decline", label: CONFIRM_NO_LABEL },
          { id: "menu", label: MAIN_MENU_LABEL },
        ],
      };
    case "clarification":
      // Clarification cards are prose-only; no sticky interaction unless contact.
      return null;
    default: {
      const _exhaustive: never = card;
      return _exhaustive;
    }
  }
};

export type ProjectPendingInteractionInput = {
  decision: BookingDecision;
  draft: BookingDraft | null;
  availabilityContext: AvailabilityContext | null;
  previousInteraction: PendingInteraction | null;
  /** Session locale for localized chip labels (kernel stays language-neutral). */
  locale?: ConversationLocale;
};

/**
 * Pure projection from the closed decision card.
 * Null card clears booking-owned interactions but preserves FAQ-owned catalog.
 */
export const projectPendingInteraction = (
  input: ProjectPendingInteractionInput,
): PendingInteraction | null => {
  const {
    decision,
    draft,
    availabilityContext,
    previousInteraction,
    locale = "uk",
  } = input;
  if (decision.card == null) {
    // Keep open chips while an effect/HITL tool round-trip runs (list_services,
    // availability, …). Clearing here dropped visit_note/DATE/TIME mid-fetch.
    if (decision.tag === "effect" || decision.tag === "mutation_confirm") {
      return previousInteraction;
    }
    if (
      previousInteraction?.kind === "service_candidate"
      && previousInteraction.owner === "faq"
    ) {
      return previousInteraction;
    }
    if (isBookingOwnedInteraction(previousInteraction)) {
      return null;
    }
    return previousInteraction;
  }
  return projectCard(decision.card, draft, availabilityContext, locale);
};

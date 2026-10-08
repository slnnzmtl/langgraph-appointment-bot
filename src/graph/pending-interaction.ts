import { INTENT_SKIP_LABEL } from "../shared/clinic-constants.js";
import {
  reduceBookingDraft,
  type BookingDraft,
  type BookingService,
} from "./booking-draft.js";

export type InteractionChoice = {
  id: string;
  label: string;
  /** CRM ids covered by this catalog-level option. Singleton groups apply that id. */
  serviceIds?: string[];
};

export type VisitNoteInteraction = {
  kind: "visit_note";
  choices: InteractionChoice[];
};

export type ServiceOrNoteInteraction = {
  kind: "service_or_note";
  currentService: { id: string; name?: string };
  query?: string;
  noteCandidate: string;
  choices: InteractionChoice[];
};

export type ServiceCandidateInteraction = {
  kind: "service_candidate";
  utterance: string;
  query?: string;
  noteCandidate?: string;
  choices: InteractionChoice[];
};

/** Booking-owned kinds for phases 3–4. Later phases may extend this union. */
export type PendingInteraction =
  | VisitNoteInteraction
  | ServiceOrNoteInteraction
  | ServiceCandidateInteraction;

export const BOOKING_OWNED_INTERACTION_KINDS = [
  "visit_note",
  "service_or_note",
  "service_candidate",
] as const;

export type BookingOwnedInteractionKind = (typeof BOOKING_OWNED_INTERACTION_KINDS)[number];

export const isBookingOwnedInteraction = (
  interaction: PendingInteraction | null | undefined,
): interaction is PendingInteraction =>
  interaction != null
  && (BOOKING_OWNED_INTERACTION_KINDS as readonly string[]).includes(interaction.kind);

/** Clear booking-owned interactions only; leave future FAQ/contact kinds intact. */
export const clearBookingOwnedInteraction = (
  interaction: PendingInteraction | null | undefined,
): PendingInteraction | null => {
  if (interaction == null) {
    return null;
  }
  if (isBookingOwnedInteraction(interaction)) {
    return null;
  }
  return interaction;
};

export const openVisitNoteInteraction = (
  skipLabel: string = INTENT_SKIP_LABEL,
): VisitNoteInteraction => ({
  kind: "visit_note",
  choices: [{ id: "skip", label: skipLabel }],
});

export type ResolveServiceEffect = {
  type: "resolve_service";
  utterance: string;
  query?: string;
  noteCandidate?: string;
  /** Already-narrowed CRM ids; skip full-catalog filter and group among these only. */
  remainingIds?: string[];
};

export type ApplyServiceChoiceEffect = {
  type: "apply_service_choice";
  serviceId: string;
  label: string;
  noteCandidate?: string;
};

export type BookingSessionEffect = ResolveServiceEffect | ApplyServiceChoiceEffect;

export type BookingSessionState = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
};

export type BookingSessionReduction = BookingSessionState & {
  clearAvailability: boolean;
  effect: BookingSessionEffect | null;
};

export type BookingSessionEvent =
  | { type: "slot_selected"; slot: NonNullable<BookingDraft["selectedSlot"]> }
  | { type: "date_selected"; date: string }
  | { type: "note_provided"; value: string }
  | { type: "note_skipped" }
  | {
      type: "service_or_note_opened";
      query?: string;
      noteCandidate: string;
      choices: InteractionChoice[];
    }
  | {
      type: "service_change_requested";
      utterance: string;
      query?: string;
      noteCandidate?: string;
    }
  | { type: "interaction_choice"; choiceId: string }
  | {
      type: "service_changed";
      service: BookingService;
      accepted: boolean;
      noteCandidate?: string;
      turn?: number;
    }
  | {
      type: "service_candidates_opened";
      utterance: string;
      query?: string;
      noteCandidate?: string;
      choices: InteractionChoice[];
    }
  | { type: "service_unresolved"; returnLabel: string }
  | { type: "leave_booking"; destination: "main_menu" }
  | { type: "draft_event"; event: Parameters<typeof reduceBookingDraft>[1] };

const noEffect = (
  state: BookingSessionState,
  clearAvailability = false,
): BookingSessionReduction => ({
  ...state,
  clearAvailability,
  effect: null,
});

const choiceById = (
  interaction: PendingInteraction | null,
  choiceId: string,
): InteractionChoice | null =>
  interaction?.choices.find((choice) => choice.id === choiceId) ?? null;

const withoutReturnChoice = (interaction: PendingInteraction): PendingInteraction => ({
  ...interaction,
  choices: interaction.choices.filter((choice) => choice.id !== "return_to_booking"),
});

const withReturnChoice = (
  interaction: PendingInteraction,
  returnLabel: string,
): PendingInteraction => {
  const without = withoutReturnChoice(interaction);
  return {
    ...without,
    choices: [...without.choices, { id: "return_to_booking", label: returnLabel }],
  };
};

/**
 * visit_note requires a selected slot. Clear booking-owned UI when a schedule
 * transition drops that slot, or when visit_note is already illegal.
 */
const clearInteractionAfterSlotDrop = (
  draft: BookingDraft | null | undefined,
  interaction: PendingInteraction | null,
  nextDraft: BookingDraft | null,
): PendingInteraction | null => {
  const droppedSlot = draft?.selectedSlot != null && nextDraft?.selectedSlot == null;
  if (droppedSlot || interaction?.kind === "visit_note") {
    return clearBookingOwnedInteraction(interaction);
  }
  return interaction;
};

/**
 * Sole transition that updates the booking draft and booking-owned pendingInteraction
 * together. Callers dispatch events; they do not construct visit_note themselves.
 */
export const reduceBookingSession = (
  current: BookingSessionState,
  event: BookingSessionEvent,
): BookingSessionReduction => {
  const draft = current.bookingDraft;
  const interaction = current.pendingInteraction;

  switch (event.type) {
    case "draft_event": {
      const nextDraft = reduceBookingDraft(draft, event.event);
      const nextInteraction = event.event.type === "slot_invalidated"
        ? clearInteractionAfterSlotDrop(draft, interaction, nextDraft)
        : interaction;
      return noEffect({
        bookingDraft: nextDraft,
        pendingInteraction: nextInteraction,
      });
    }
    case "slot_selected": {
      const nextDraft = reduceBookingDraft(draft, {
        type: "slot_selected",
        slot: event.slot,
      });
      if (nextDraft == null) {
        return noEffect(current);
      }
      const noteWasUnasked = (draft?.note.status ?? "unasked") === "unasked";
      const noteNowAwaiting = nextDraft.note.status === "awaiting";
      if (noteWasUnasked && noteNowAwaiting) {
        return noEffect({
          bookingDraft: nextDraft,
          pendingInteraction: openVisitNoteInteraction(),
        });
      }
      return noEffect({
        bookingDraft: nextDraft,
        pendingInteraction: clearBookingOwnedInteraction(interaction),
      });
    }
    case "date_selected": {
      const nextDraft = reduceBookingDraft(draft, {
        type: "date_selected",
        date: event.date,
      });
      return noEffect({
        bookingDraft: nextDraft,
        pendingInteraction: clearInteractionAfterSlotDrop(draft, interaction, nextDraft),
      });
    }
    case "leave_booking": {
      return noEffect({
        bookingDraft: null,
        pendingInteraction: clearBookingOwnedInteraction(interaction),
      });
    }
    case "note_provided": {
      if (draft == null || draft.selectedSlot == null) {
        return noEffect(current);
      }
      return noEffect({
        bookingDraft: reduceBookingDraft(draft, {
          type: "note_status",
          status: "answered",
          value: event.value,
        }),
        pendingInteraction: clearBookingOwnedInteraction(interaction),
      });
    }
    case "note_skipped": {
      if (draft == null || draft.selectedSlot == null) {
        return noEffect(current);
      }
      return noEffect({
        bookingDraft: reduceBookingDraft(draft, {
          type: "note_status",
          status: "skipped",
        }),
        pendingInteraction: clearBookingOwnedInteraction(interaction),
      });
    }
    case "service_or_note_opened": {
      if (draft?.serviceAcceptance == null) {
        return noEffect(current);
      }
      const service = draft.serviceAcceptance.service;
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: {
          kind: "service_or_note",
          currentService: {
            id: service.id,
            ...(service.name != null ? { name: service.name } : {}),
          },
          ...(event.query != null ? { query: event.query } : {}),
          noteCandidate: event.noteCandidate,
          choices: event.choices,
        },
      });
    }
    case "service_change_requested": {
      return {
        bookingDraft: draft,
        pendingInteraction: interaction,
        clearAvailability: false,
        effect: {
          type: "resolve_service",
          utterance: event.utterance,
          ...(event.query != null ? { query: event.query } : {}),
          ...(event.noteCandidate != null ? { noteCandidate: event.noteCandidate } : {}),
        },
      };
    }
    case "interaction_choice": {
      if (interaction == null || choiceById(interaction, event.choiceId) == null) {
        return noEffect(current);
      }
      if (event.choiceId === "return_to_booking") {
        return noEffect({
          bookingDraft: draft,
          pendingInteraction: withoutReturnChoice(interaction),
        });
      }
      if (interaction.kind === "visit_note" && event.choiceId === "skip") {
        return reduceBookingSession(current, { type: "note_skipped" });
      }
      if (interaction.kind === "service_or_note") {
        if (event.choiceId === "keep_service") {
          return noEffect({
            bookingDraft: reduceBookingDraft(draft, {
              type: "note_status",
              status: "answered",
              value: interaction.noteCandidate,
            }),
            pendingInteraction: null,
          });
        }
        if (event.choiceId === "switch_service") {
          return {
            bookingDraft: draft,
            pendingInteraction: interaction,
            clearAvailability: false,
            effect: {
              type: "resolve_service",
              utterance: interaction.noteCandidate,
              ...(interaction.query != null ? { query: interaction.query } : {}),
              noteCandidate: interaction.noteCandidate,
            },
          };
        }
      }
      if (interaction.kind === "service_candidate") {
        const choice = choiceById(interaction, event.choiceId)!;
        const remainingIds = choice.serviceIds != null && choice.serviceIds.length > 0
          ? choice.serviceIds
          : [choice.id];
        if (remainingIds.length > 1) {
          return {
            bookingDraft: draft,
            pendingInteraction: interaction,
            clearAvailability: false,
            effect: {
              type: "resolve_service",
              utterance: interaction.utterance,
              ...(interaction.query != null ? { query: interaction.query } : {}),
              ...(interaction.noteCandidate != null
                ? { noteCandidate: interaction.noteCandidate }
                : {}),
              remainingIds,
            },
          };
        }
        return {
          bookingDraft: draft,
          pendingInteraction: interaction,
          clearAvailability: false,
          effect: {
            type: "apply_service_choice",
            serviceId: remainingIds[0]!,
            label: choice.label,
            ...(interaction.noteCandidate != null
              ? { noteCandidate: interaction.noteCandidate }
              : {}),
          },
        };
      }
      return noEffect(current);
    }
    case "service_changed": {
      if (draft == null) {
        return noEffect(current);
      }
      // Different service id: clearDownstream then set service. Carry noteCandidate
      // by answering the note after the service change when provided.
      let next = reduceBookingDraft(draft, {
        type: "service_selected",
        service: event.service,
        accepted: event.accepted,
        ...(event.turn != null ? { turn: event.turn } : {}),
      });
      if (next == null) {
        return noEffect(current);
      }
      if (event.noteCandidate != null) {
        // After a service change the slot is cleared, so note_status would be ignored.
        // Write the answered note directly onto the cleared aggregate.
        next = {
          ...next,
          note: { status: "answered", value: event.noteCandidate },
          phase: "date",
        };
      }
      return {
        bookingDraft: next,
        pendingInteraction: null,
        clearAvailability: true,
        effect: null,
      };
    }
    case "service_candidates_opened": {
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: {
          kind: "service_candidate",
          utterance: event.utterance,
          ...(event.query != null ? { query: event.query } : {}),
          ...(event.noteCandidate != null ? { noteCandidate: event.noteCandidate } : {}),
          choices: event.choices,
        },
      });
    }
    case "service_unresolved": {
      const preserved: PendingInteraction = interaction != null
        ? interaction
        : openVisitNoteInteraction();
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: withReturnChoice(preserved, event.returnLabel),
      });
    }
    default:
      return noEffect(current);
  }
};

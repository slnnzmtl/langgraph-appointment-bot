import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  CONSULTATION_SERVICE_ID,
  CONSULTATION_SERVICE_NAME_UK,
  INTENT_SKIP_LABEL,
  SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
} from "../shared/clinic-constants.js";
import { matchesReplyLabel } from "../shared/message-content.js";
import {
  bookingDraftCanPresentAvailability,
  effectiveBookingContactDetails,
  nextMissingContactField,
  reduceBookingDraft,
  type BookingContactField,
  type BookingDraft,
  type BookingService,
} from "./booking-draft.js";
import {
  type BookingCheckpointLegacyState,
  type BookingCheckpointUpgradeResult,
  upgradeBookingDraftCheckpoint,
} from "./booking-checkpoint-upgrade.js";
import { cancelCommandFromMeeting } from "./cancel-command.js";

export const consultationService = (source: "catalog" | "direct"): {
  id: string;
  name: string;
  source: "catalog" | "direct";
} => ({
  id: CONSULTATION_SERVICE_ID,
  name: CONSULTATION_SERVICE_NAME_UK,
  source,
});

export type InteractionChoice = {
  id: string;
  /** Telegram chip label (may be length-capped). */
  label: string;
  /**
   * Full patient-facing label for message bullets when longer than the chip.
   * Absent when identical to {@link label}.
   */
  displayLabel?: string;
  /**
   * Extra exact reply texts that resolve to this choice (e.g. «Так» affirming
   * a cancel-and-rebook offer whose chip label is «Скасувати»).
   */
  aliases?: string[];
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
  /** Who owns this catalog wait: booking = mid-flow change; faq = catalog browse. */
  owner?: "faq" | "booking";
  /**
   * True after the patient declined a consultation offer («Обрати іншу процедуру»
   * / bare «Ні»). FAQ must not re-offer consultation while browsing.
   */
  consultationDeclined?: boolean;
  choices: InteractionChoice[];
};

/** FAQ catalog detour after unresolved service; carries only return_to_booking. */
export type CatalogDetourInteraction = {
  kind: "catalog_detour";
  choices: InteractionChoice[];
};

export type ServiceConfirmInteraction = {
  kind: "service_confirm";
  service: BookingService;
  choices: InteractionChoice[];
};

/** Immutable copy for DATE/TIME cards — choices alone cannot rebuild hours/headings. */
export type AvailabilityRenderSlot = {
  id: string;
  label: string;
  dateStart: string;
  dateEnd: string;
};

export type AvailabilityRenderDay = {
  date: string;
  displayLabel: string;
  slotSummaries: string[];
  slots: AvailabilityRenderSlot[];
};

export type AvailabilityRenderSnapshot = {
  snapshotId: string;
  queryKind?: "exact" | "earlier" | "later" | "nearest";
  queryAnchor?: string;
  days: AvailabilityRenderDay[];
  /** Empty-window prompts (earlier/later only). */
  emptyMode?: "earlier" | "exact" | "other";
  canSearchEarlier?: boolean;
};

export type DateSelectInteraction = {
  kind: "date_select";
  snapshot: AvailabilityRenderSnapshot;
  choices: InteractionChoice[];
};

export type TimeSelectInteraction = {
  kind: "time_select";
  date: string;
  snapshot: AvailabilityRenderSnapshot;
  choices: InteractionChoice[];
};

export type VisitSelectMeeting = {
  id: string;
  name?: string;
  dateStart?: string;
  dateEnd?: string;
};

export type VisitSelectInteraction = {
  kind: "visit_select";
  stage: "action" | "meeting" | "replacement";
  /** Known meeting when stage is action/replacement; selected target when stage is meeting. */
  meetingId?: string;
  /** Action already chosen when stage is meeting. */
  action?: "reschedule" | "cancel";
  meetings?: VisitSelectMeeting[];
  choices: InteractionChoice[];
};

export type ContactFieldCollected = {
  firstName?: string;
  lastName?: string;
};

export type ContactFieldInteraction = {
  kind: "contact_field";
  field: "phoneNumber" | "firstName" | "lastName";
  /** Occupied-phone copy stays open until a different number succeeds. */
  occupied?: boolean;
  /** Names accepted by the contact-name classifier this session. */
  collected?: ContactFieldCollected;
  choices: InteractionChoice[];
};

export type MutationConfirmInteraction = {
  kind: "mutation_confirm";
  action: "create" | "reschedule" | "cancel";
  choices: InteractionChoice[];
};

/** Booking-owned pendingInteraction kinds. */
export type PendingInteraction =
  | VisitNoteInteraction
  | ServiceOrNoteInteraction
  | ServiceCandidateInteraction
  | CatalogDetourInteraction
  | ServiceConfirmInteraction
  | DateSelectInteraction
  | TimeSelectInteraction
  | VisitSelectInteraction
  | ContactFieldInteraction
  | MutationConfirmInteraction;

export const BOOKING_OWNED_INTERACTION_KINDS = [
  "visit_note",
  "service_or_note",
  "service_candidate",
  "catalog_detour",
  "service_confirm",
  "date_select",
  "time_select",
  "visit_select",
  "contact_field",
  "mutation_confirm",
] as const;

export const isBookingOwnedInteraction = (
  interaction: PendingInteraction | null | undefined,
): interaction is PendingInteraction =>
  interaction != null
  && (BOOKING_OWNED_INTERACTION_KINDS as readonly string[]).includes(interaction.kind);

/** Clear any booking-owned pendingInteraction (the union is booking-owned only). */
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

export const openCatalogDetourInteraction = (
  returnLabel: string,
): CatalogDetourInteraction => ({
  kind: "catalog_detour",
  choices: [{ id: "return_to_booking", label: returnLabel }],
});

export const openServiceConfirmInteraction = (
  service: BookingService,
  acceptLabel: string = BOOKING_OFFER_MENU[0],
  chooseOtherLabel: string = BOOKING_OFFER_MENU[1],
): ServiceConfirmInteraction => ({
  kind: "service_confirm",
  service,
  choices: [
    { id: "accept", label: acceptLabel },
    {
      id: "choose_other",
      label: chooseOtherLabel,
      aliases: [...SERVICE_CONFIRM_CHOOSE_OTHER_ALIASES],
    },
  ],
});

/** Unique patient-facing label for a meeting when several visits are listed. */
export const visitMeetingChoiceLabel = (meeting: VisitSelectMeeting): string => {
  const name = meeting.name?.trim() || "Візит";
  const day = meeting.dateStart?.slice(0, 10) ?? "";
  const time = meeting.dateStart?.slice(11, 16) ?? "";
  const when = [day, time].filter((part) => part.length > 0).join(" ");
  return when.length > 0 ? `${name} — ${when}` : name;
};

/** Move / Cancel / No thanks after «Мій запис». meetingId only when exactly one visit. */
export const openVisitActionMenuInteraction = (
  meetings: VisitSelectMeeting[],
): VisitSelectInteraction => ({
  kind: "visit_select",
  stage: "action",
  ...(meetings.length === 1 ? { meetingId: meetings[0]!.id } : {}),
  meetings,
  choices: [
    {
      id: "reschedule",
      label: VISIT_CHANGE_MENU[0],
      aliases: [VISIT_CHANGE_MENU_EN[0]],
    },
    {
      id: "cancel",
      label: VISIT_CHANGE_MENU[1],
      aliases: [VISIT_CHANGE_MENU_EN[1]],
    },
    {
      id: "decline",
      label: VISIT_CHANGE_MENU[2],
      aliases: [VISIT_CHANGE_MENU_EN[2]],
    },
  ],
});

export const openVisitMeetingInteraction = (
  action: "reschedule" | "cancel",
  meetings: VisitSelectMeeting[],
): VisitSelectInteraction => ({
  kind: "visit_select",
  stage: "meeting",
  action,
  meetings,
  choices: meetings.map((meeting) => ({
    id: meeting.id,
    label: visitMeetingChoiceLabel(meeting),
  })),
});

export const openVisitReplacementInteraction = (
  meeting: VisitSelectMeeting,
): VisitSelectInteraction => ({
  kind: "visit_select",
  stage: "replacement",
  meetingId: meeting.id,
  meetings: [meeting],
  choices: [
    {
      id: "cancel_existing",
      label: BOOKING_REPLACE_MENU[0],
      // Affirmation of the "cancel current and book new" offer.
      aliases: [
        BOOKING_OFFER_MENU[0],
        BOOKING_OFFER_MENU_EN[0],
        BOOKING_REPLACE_MENU_EN[0],
      ],
    },
    {
      id: "decline",
      label: BOOKING_REPLACE_MENU[1],
      aliases: [BOOKING_REPLACE_MENU_EN[1]],
    },
  ],
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

/** Browse FAQ catalog (choose_other wipe → FAQ prepare, or service_unresolved detour). */
export type OpenFaqCatalogEffect = {
  type: "open_faq_catalog";
};

export type BookingSessionEffect =
  | ResolveServiceEffect
  | ApplyServiceChoiceEffect
  | OpenFaqCatalogEffect;

export const openContactFieldInteraction = (
  field: ContactFieldInteraction["field"],
  occupied = false,
  collected?: ContactFieldCollected,
): ContactFieldInteraction => ({
  kind: "contact_field",
  field,
  occupied,
  ...(collected != null && Object.keys(collected).length > 0 ? { collected } : {}),
  choices: [],
});

export const openMutationConfirmInteraction = (
  action: MutationConfirmInteraction["action"],
): MutationConfirmInteraction => ({
  kind: "mutation_confirm",
  action,
  choices: [
    { id: "confirm", label: "✅" },
    { id: "decline", label: "❌" },
  ],
});

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
      owner?: "faq" | "booking";
      consultationDeclined?: boolean;
      choices: InteractionChoice[];
    }
  | { type: "service_unresolved"; returnLabel: string }
  | {
      type: "service_offered";
      service: BookingService;
      acceptLabel?: string;
      chooseOtherLabel?: string;
    }
  | {
      type: "availability_presented";
      interaction: DateSelectInteraction | TimeSelectInteraction;
    }
  | {
      type: "service_confirm_schedule";
      schedule:
        | { type: "date_selected"; date: string }
        | { type: "slot_selected"; slot: NonNullable<BookingDraft["selectedSlot"]> };
      turn?: number;
    }
  | {
      type: "visit_menu_opened";
      interaction: VisitSelectInteraction;
    }
  | {
      type: "contact_field_required";
      field: ContactFieldInteraction["field"];
      occupied?: boolean;
    }
  | {
      /** Persist accepted identity on the draft and advance/clear the open contact_field. */
      type: "contact_field_submitted";
      field: BookingContactField;
      value: string;
      /** Owned CRM row so progression overlays phone/name already on the contact. */
      crmContact?: Record<string, unknown> | null;
    }
  | {
      type: "mutation_confirm_opened";
      action: MutationConfirmInteraction["action"];
    }
  | { type: "mutation_confirm_cleared" }
  | { type: "mutation_chat_other" }
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

export type InteractionReplyMatch =
  | { kind: "choice"; choiceId: string }
  | { kind: "unmatched" };

/**
 * Kernel cards use offer_accept / offer_choose_other / note_skip.
 * Session builders still emit accept / choose_other / skip.
 * Sticky routing and session reducers must treat each pair as one choice.
 */
const INTERACTION_CHOICE_EQUIVALENTS: Readonly<Record<string, readonly string[]>> = {
  accept: ["accept", "offer_accept"],
  offer_accept: ["accept", "offer_accept"],
  choose_other: ["choose_other", "offer_choose_other"],
  offer_choose_other: ["choose_other", "offer_choose_other"],
  skip: ["skip", "note_skip"],
  note_skip: ["skip", "note_skip"],
};

export const interactionChoiceEquals = (
  actual: string | null | undefined,
  expected: string,
): boolean => {
  if (actual == null) {
    return false;
  }
  const aliases = INTERACTION_CHOICE_EQUIVALENTS[expected] ?? [expected];
  return aliases.includes(actual);
};

/** Normalize clock text: "11" / "11:00" → "11:00"; non-clock → null. */
const clockKey = (text: string): string | null => {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!match) {
    return null;
  }
  return `${Number(match[1])}:${match[2] ?? "00"}`;
};

const ISO_DATE_CHOICE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Match patient text against the current interaction only.
 * Exact label → stable choice.id. On time_select, bare hours map to HH:00 chips.
 * On date_select, a unique bare day number maps to the ISO date choice id.
 * Labels absent from the current interaction are unmatched
 * (Telegram cannot attribute reused labels to an older keyboard).
 */
export const interpretInteractionReply = (
  interaction: PendingInteraction | null | undefined,
  text: string,
): InteractionReplyMatch => {
  if (interaction == null) {
    return { kind: "unmatched" };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "unmatched" };
  }
  const choice = interaction.choices.find((entry) => {
    const labels = [entry.label, ...(entry.aliases ?? [])];
    return matchesReplyLabel(trimmed, labels);
  });
  if (choice != null) {
    return { kind: "choice", choiceId: choice.id };
  }

  if (interaction.kind === "time_select") {
    const wantClock = clockKey(trimmed.toLowerCase().replace(/\s+/g, ""));
    if (wantClock != null) {
      const clockMatches = interaction.choices.filter((entry) => {
        const labels = [entry.label, ...(entry.aliases ?? [])];
        return labels.some((label) => {
          const labelNorm = label.trim().toLowerCase().replace(/\s+/g, "");
          return clockKey(labelNorm) === wantClock;
        });
      });
      if (clockMatches.length === 1) {
        return { kind: "choice", choiceId: clockMatches[0]!.id };
      }
    }
  }

  if (interaction.kind === "date_select") {
    const bareDay = /^(\d{1,2})$/.exec(trimmed);
    if (bareDay) {
      const wanted = Number(bareDay[1]);
      const dayMatches = interaction.choices.filter(
        (entry) =>
          ISO_DATE_CHOICE.test(entry.id)
          && Number(entry.id.slice(8, 10)) === wanted,
      );
      if (dayMatches.length === 1) {
        return { kind: "choice", choiceId: dayMatches[0]!.id };
      }
    }
  }

  return { kind: "unmatched" };
};

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

/** Drop DATE/TIME cards that cannot legally be presented. */
const clearScheduleSelectInteraction = (
  interaction: PendingInteraction | null,
): PendingInteraction | null => {
  if (interaction?.kind === "date_select" || interaction?.kind === "time_select") {
    return null;
  }
  return interaction;
};

export type BookingInvariantReason =
  | "availability_without_service"
  | "date_interaction_without_draft"
  | "time_interaction_without_selected_date";

export type ScheduleInteractionRepair = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
  clearAvailability: boolean;
  reason: BookingInvariantReason;
};

/**
 * Mode-specific repair when DATE/TIME is open but the draft cannot support it.
 * Returns null when the pending schedule interaction is legal.
 */
export const repairInvalidScheduleInteraction = (
  draft: BookingDraft | null | undefined,
  interaction: PendingInteraction | null | undefined,
  meetings: VisitSelectMeeting[] = [],
): ScheduleInteractionRepair | null => {
  if (interaction?.kind !== "date_select" && interaction?.kind !== "time_select") {
    return null;
  }
  const current = draft ?? null;

  if (current?.mode === "reschedule") {
    const targetId = current.rescheduleTarget?.id?.trim() ?? "";
    if (targetId.length === 0) {
      return {
        bookingDraft: null,
        pendingInteraction: meetings.length > 0
          ? openVisitActionMenuInteraction(meetings)
          : null,
        clearAvailability: true,
        reason: "availability_without_service",
      };
    }
    if (
      interaction.kind === "time_select"
      && (current.selectedDate == null || current.selectedDate !== interaction.date)
    ) {
      const cleared = reduceBookingDraft(current, {
        type: "slot_invalidated",
        keepDate: false,
      }) ?? current;
      return {
        bookingDraft: cleared,
        pendingInteraction: null,
        clearAvailability: true,
        reason: "time_interaction_without_selected_date",
      };
    }
    if (!bookingDraftCanPresentAvailability(current)) {
      return {
        bookingDraft: null,
        pendingInteraction: meetings.length > 0
          ? openVisitActionMenuInteraction(meetings)
          : null,
        clearAvailability: true,
        reason: "availability_without_service",
      };
    }
    return null;
  }

  if (!bookingDraftCanPresentAvailability(current)) {
    const offered = reduceBookingSession(
      { bookingDraft: current, pendingInteraction: null },
      {
        type: "service_offered",
        service: consultationService("catalog"),
      },
    );
    return {
      bookingDraft: offered.bookingDraft,
      pendingInteraction: offered.pendingInteraction,
      clearAvailability: true,
      reason: interaction.kind === "date_select"
        ? "date_interaction_without_draft"
        : "availability_without_service",
    };
  }

  if (
    interaction.kind === "time_select"
    && (current!.selectedDate == null || current!.selectedDate !== interaction.date)
  ) {
    const cleared = reduceBookingDraft(current, {
      type: "slot_invalidated",
      keepDate: false,
    }) ?? current;
    return {
      bookingDraft: cleared,
      pendingInteraction: null,
      clearAvailability: true,
      reason: "time_interaction_without_selected_date",
    };
  }

  return null;
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
      if (
        nextDraft == null
        || nextDraft.selectedSlot?.dateStart !== event.slot.dateStart
      ) {
        return {
          bookingDraft: draft ?? null,
          pendingInteraction: clearScheduleSelectInteraction(interaction),
          clearAvailability: true,
          effect: null,
        };
      }
      const noteWasUnasked = (draft?.note.status ?? "unasked") === "unasked";
      const noteNowAwaiting = nextDraft.note.status === "awaiting";
      if (noteWasUnasked && noteNowAwaiting) {
        return noEffect({
          bookingDraft: nextDraft,
          pendingInteraction: openVisitNoteInteraction(),
        });
      }
      // New slot while note is still awaiting — keep the skip chip; never clear
      // visit_note and fall through to the booking LLM mid-note.
      if (nextDraft.note.status === "awaiting") {
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
      if (nextDraft == null || nextDraft.selectedDate !== event.date) {
        return {
          bookingDraft: draft ?? null,
          pendingInteraction: clearScheduleSelectInteraction(interaction),
          clearAvailability: true,
          effect: null,
        };
      }
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
        if (interaction.kind === "catalog_detour") {
          return noEffect({
            bookingDraft: draft,
            pendingInteraction: null,
          });
        }
        return noEffect({
          bookingDraft: draft,
          pendingInteraction: withoutReturnChoice(interaction),
        });
      }
      if (interaction.kind === "visit_note" && interactionChoiceEquals(event.choiceId, "skip")) {
        return reduceBookingSession(current, { type: "note_skipped" });
      }
      if (interaction.kind === "service_confirm") {
        if (interactionChoiceEquals(event.choiceId, "accept")) {
          if (draft == null) {
            return noEffect(current);
          }
          // Drop any stale DATE snapshot so command_prepare injects a fresh
          // nearest search for the accepted service duration.
          return {
            bookingDraft: reduceBookingDraft(draft, {
              type: "service_accepted",
            }),
            pendingInteraction: null,
            clearAvailability: true,
            effect: null,
          };
        }
        if (interactionChoiceEquals(event.choiceId, "choose_other")) {
          // Same policy as supervisor faqPredicates: wipe the offer and browse FAQ.
          // catalog_detour is reserved for service_unresolved (preserve draft).
          return {
            bookingDraft: null,
            pendingInteraction: null,
            clearAvailability: true,
            effect: { type: "open_faq_catalog" },
          };
        }
      }
      if (interaction.kind === "visit_select") {
        if (event.choiceId === "decline") {
          return noEffect({
            bookingDraft: draft,
            pendingInteraction: null,
          });
        }
        if (interaction.stage === "action") {
          if (event.choiceId === "reschedule" || event.choiceId === "cancel") {
            const meetings = interaction.meetings ?? [];
            if (meetings.length > 1) {
              return noEffect({
                bookingDraft: draft,
                pendingInteraction: openVisitMeetingInteraction(
                  event.choiceId,
                  meetings,
                ),
              });
            }
            const meeting = meetings.find((entry) => entry.id === interaction.meetingId)
              ?? (interaction.meetingId != null
                ? { id: interaction.meetingId }
                : meetings[0] ?? null);
            if (meeting == null) {
              return noEffect(current);
            }
            if (event.choiceId === "reschedule") {
              return noEffect({
                bookingDraft: reduceBookingDraft(draft, {
                  type: "reschedule_started",
                  meeting,
                }),
                pendingInteraction: null,
              });
            }
            return noEffect({
              bookingDraft: reduceBookingDraft(draft, {
                type: "command_prepared",
                command: cancelCommandFromMeeting(meeting),
              }),
              pendingInteraction: null,
            });
          }
        }
        if (interaction.stage === "meeting") {
          const meeting = interaction.meetings?.find((m) => m.id === event.choiceId);
          if (meeting == null) {
            return noEffect(current);
          }
          if (interaction.action === "reschedule") {
            return noEffect({
              bookingDraft: reduceBookingDraft(draft, {
                type: "reschedule_started",
                meeting,
              }),
              pendingInteraction: null,
            });
          }
          return noEffect({
            bookingDraft: reduceBookingDraft(draft, {
              type: "command_prepared",
              command: cancelCommandFromMeeting(meeting),
            }),
            pendingInteraction: null,
          });
        }
        if (interaction.stage === "replacement") {
          if (event.choiceId === "cancel_existing") {
            return noEffect({
              bookingDraft: draft,
              pendingInteraction: null,
            });
          }
        }
      }
      // mutation_confirm affirm/decline are resume decisions (confirmed / left),
      // not interaction_choice events — the adapter no longer pre-patches here.
      if (interaction.kind === "date_select" || interaction.kind === "time_select") {
        if (event.choiceId === "other_date" || event.choiceId === "earlier" || event.choiceId === "later") {
          return noEffect({
            bookingDraft: draft,
            pendingInteraction: null,
          });
        }
        if (interaction.kind === "date_select" && /^\d{4}-\d{2}-\d{2}$/.test(event.choiceId)) {
          return reduceBookingSession(current, {
            type: "date_selected",
            date: event.choiceId,
          });
        }
        if (interaction.kind === "time_select") {
          const day = interaction.snapshot.days.find((entry) => entry.date === interaction.date);
          const slot = day?.slots.find((entry) => entry.id === event.choiceId);
          if (slot == null) {
            return noEffect(current);
          }
          return reduceBookingSession(current, {
            type: "slot_selected",
            slot: {
              slotId: slot.id,
              dateStart: slot.dateStart,
              dateEnd: slot.dateEnd,
              label: slot.label,
            },
          });
        }
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
            label: choice.displayLabel ?? choice.label,
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
      const currentServiceId = draft.serviceAcceptance?.service.id;
      // Same service id is keep, not a service change: preserve schedule facts.
      if (currentServiceId != null && currentServiceId === event.service.id) {
        let next = reduceBookingDraft(draft, {
          type: "service_selected",
          service: event.service,
          accepted: event.accepted,
          ...(event.turn != null ? { turn: event.turn } : {}),
        });
        if (next == null) {
          return noEffect(current);
        }
        if (event.noteCandidate != null && next.selectedSlot != null) {
          next = reduceBookingDraft(next, {
            type: "note_status",
            status: "answered",
            value: event.noteCandidate,
          });
        }
        return {
          bookingDraft: next,
          pendingInteraction: null,
          clearAvailability: false,
          effect: null,
        };
      }
      // Different service id: clearDownstream then set service. Leave note unasked;
      // noteCandidate is only for same-id keep / catalog resolution, not the new visit.
      const next = reduceBookingDraft(draft, {
        type: "service_selected",
        service: event.service,
        accepted: event.accepted,
        ...(event.turn != null ? { turn: event.turn } : {}),
      });
      if (next == null) {
        return noEffect(current);
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
          owner: event.owner ?? "booking",
          ...(event.consultationDeclined === true
            ? { consultationDeclined: true }
            : {}),
          choices: event.choices,
        },
      });
    }
    case "service_unresolved": {
      const preserved: PendingInteraction = interaction != null
        ? withReturnChoice(interaction, event.returnLabel)
        : openCatalogDetourInteraction(event.returnLabel);
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: preserved,
      });
    }
    case "service_offered": {
      const nextDraft = reduceBookingDraft(draft, {
        type: "service_selected",
        service: event.service,
        accepted: false,
      });
      return noEffect({
        bookingDraft: nextDraft,
        pendingInteraction: openServiceConfirmInteraction(
          event.service,
          event.acceptLabel,
          event.chooseOtherLabel,
        ),
      });
    }
    case "availability_presented": {
      if (!bookingDraftCanPresentAvailability(draft)) {
        return {
          bookingDraft: draft ?? null,
          pendingInteraction: clearScheduleSelectInteraction(interaction),
          clearAvailability: true,
          effect: null,
        };
      }
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: event.interaction,
      });
    }
    case "visit_menu_opened": {
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: event.interaction,
      });
    }
    case "contact_field_required": {
      // Preserve leftover collected only for checkpoint compatibility reads;
      // new identity writes go to bookingDraft.contactDetails.
      const prevCollected = interaction?.kind === "contact_field"
        ? interaction.collected
        : undefined;
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: openContactFieldInteraction(
          event.field,
          event.occupied === true,
          prevCollected,
        ),
      });
    }
    case "contact_field_submitted": {
      if (interaction?.kind !== "contact_field") {
        return noEffect(current);
      }
      if (interaction.field !== event.field) {
        return noEffect(current);
      }
      if (draft == null) {
        return noEffect(current);
      }
      let nextDraft = reduceBookingDraft(draft, {
        type: "contact_field_submitted",
        field: event.field,
        value: event.value,
      });
      if (nextDraft == null || nextDraft === draft) {
        return noEffect(current);
      }
      // Persist leftover collected names onto the draft so clearing the UI
      // cannot drop accepted identity (checkpoint compatibility).
      const collected = interaction.collected;
      if (collected != null) {
        for (const nameField of ["firstName", "lastName"] as const) {
          const leftover = collected[nameField];
          if (
            typeof leftover === "string"
            && leftover.trim().length > 0
            && nextDraft.contactDetails?.[nameField] == null
          ) {
            const folded = reduceBookingDraft(nextDraft, {
              type: "contact_field_submitted",
              field: nameField,
              value: leftover,
            });
            if (folded != null) {
              nextDraft = folded;
            }
          }
        }
      }
      const missing = nextMissingContactField(
        effectiveBookingContactDetails({
          ...(event.crmContact !== undefined ? { crmContact: event.crmContact } : {}),
          contactDetails: nextDraft.contactDetails ?? null,
        }),
      );
      if (missing == null) {
        return noEffect({
          bookingDraft: nextDraft,
          pendingInteraction: null,
        });
      }
      return noEffect({
        bookingDraft: nextDraft,
        pendingInteraction: openContactFieldInteraction(missing),
      });
    }
    case "mutation_confirm_opened": {
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: openMutationConfirmInteraction(event.action),
      });
    }
    case "mutation_confirm_cleared": {
      if (interaction?.kind !== "mutation_confirm") {
        return noEffect(current);
      }
      return noEffect({
        bookingDraft: draft,
        pendingInteraction: null,
      });
    }
    case "mutation_chat_other": {
      // Chat text while HITL is paused: invalidate the frozen mutation but keep
      // mutation_confirm until tools/finalize clear it. Affirm/decline/leave use
      // typed resume payloads and never reach this event.
      if (interaction?.kind !== "mutation_confirm") {
        return noEffect(current);
      }
      const action = interaction.action;
      if (action === "create" || action === "reschedule") {
        if (draft == null) {
          return noEffect({ bookingDraft: null, pendingInteraction: interaction });
        }
        return noEffect({
          bookingDraft: reduceBookingDraft(draft, {
            type: "slot_invalidated",
            keepDate: true,
          }),
          pendingInteraction: interaction,
        });
      }
      if (draft?.replacement?.status === "cancelling") {
        return noEffect({
          bookingDraft: null,
          pendingInteraction: null,
        }, true);
      }
      return noEffect({
        bookingDraft: draft != null
          ? reduceBookingDraft(draft, { type: "command_cleared" })
          : null,
        pendingInteraction: interaction,
      });
    }
    case "service_confirm_schedule": {
      if (interaction?.kind !== "service_confirm") {
        return noEffect(current);
      }
      let nextDraft = draft;
      if (nextDraft != null) {
        nextDraft = reduceBookingDraft(nextDraft, {
          type: "service_accepted",
          ...(event.turn != null ? { turn: event.turn } : {}),
        });
      }
      if (event.schedule.type === "date_selected") {
        return reduceBookingSession(
          { bookingDraft: nextDraft, pendingInteraction: null },
          { type: "date_selected", date: event.schedule.date },
        );
      }
      return reduceBookingSession(
        { bookingDraft: nextDraft, pendingInteraction: null },
        { type: "slot_selected", slot: event.schedule.slot },
      );
    }
    default:
      return noEffect(current);
  }
};

/** Open visit_note once when a checkpoint already awaits a note after a slot pick. */
const pendingInteractionForUpgradedDraft = (
  draft: BookingDraft | null | undefined,
): PendingInteraction | null => {
  if (draft == null || draft.selectedSlot == null || draft.note.status !== "awaiting") {
    return null;
  }
  return openVisitNoteInteraction();
};

/**
 * Upgrade a version-0 booking checkpoint and open visit_note when the draft
 * awaits a note with a selected slot. Draft facts stay in booking-draft.
 */
export const upgradeBookingCheckpoint = (
  state: BookingCheckpointLegacyState,
): BookingCheckpointUpgradeResult => {
  const result = upgradeBookingDraftCheckpoint(state);
  const draft = result.update.bookingDraft;
  if (draft == null) {
    return result;
  }
  return {
    ...result,
    update: {
      ...result.update,
      pendingInteraction: pendingInteractionForUpgradedDraft(draft),
    },
  };
};

/** Atomically close a booking session (draft + booking-owned interaction only). */
export const closedBookingSessionUpdate = (
  pendingInteraction?: PendingInteraction | null,
): {
  bookingDraft: null;
  pendingInteraction: PendingInteraction | null;
} => ({
  bookingDraft: null,
  pendingInteraction: clearBookingOwnedInteraction(pendingInteraction),
});

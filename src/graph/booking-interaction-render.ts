import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_OFFER_MENU_EN,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_UK,
  CONSULTATION_SERVICE_ID,
  SERVICE_CHANGE_ACK_UK,
  SERVICE_CONFIRM_CONSULTATION_EN,
  SERVICE_CONFIRM_CONSULTATION_UK,
  SERVICE_CONFIRM_PROCEDURE_EN,
  SERVICE_CONFIRM_PROCEDURE_UK,
  CLINIC_SLOT_MINUTES,
} from "../shared/clinic-constants.js";
import { isOtherDateChip } from "../shared/other-date-chip.js";
import { extractMessageTextContent } from "../shared/message-content.js";
import type { ClinicState } from "./state.js";
import { availabilityMatchesBooking } from "./booking-draft.js";
import {
  availabilitySlotsRanThisTurn,
  captureAvailabilityFromMessages,
} from "./agent-loop/protocol/index.js";
import {
  availabilityQueryFromContext,
  type AvailabilityContext,
} from "../tools/availability-tools.js";
import {
  formatKyivDayLabel,
  kyivToday,
  shortDayMonthLabel,
} from "../tools/availability-slots.js";
import type {
  AvailabilityRenderSnapshot,
  DateSelectInteraction,
  PendingInteraction,
  TimeSelectInteraction,
} from "./booking-session.js";
import {
  presentationSnapshotId,
  projectAvailabilityPresentation,
  projectEmptyAvailabilityPresentation,
} from "./booking-domain/availability-presentation.js";

const FAQ_CATALOG_CLOSE_UK = "Який варіант вам підходить?";

/** Visible bullets must match the reply keyboard (FAQ catalog pattern). */
const choiceBullets = (interaction: PendingInteraction): string => {
  const labels = interaction.choices
    .map((choice) => choice.label.trim())
    .filter((label) => label.length > 0);
  if (labels.length === 0) {
    return "";
  }
  return `${labels.map((label) => `• ${label}`).join("\n")}\n\n${FAQ_CATALOG_CLOSE_UK}`;
};

const AVAILABILITY_DATE_HEADING = "Найближчі вільні дні";
const AVAILABILITY_GENERIC_DATE_HEADING = "Доступні дні";
const AVAILABILITY_TIME_HEADING = "Вільні години на ";

/** Shared DATE-page heading from a search query kind + optional anchor. */
export const availabilityDateHeading = (
  queryKind: AvailabilityRenderSnapshot["queryKind"],
  queryAnchor?: string,
): string => {
  if (queryKind === "nearest") {
    return AVAILABILITY_DATE_HEADING;
  }
  if (queryKind === "later" && queryAnchor) {
    return `Вільні дні після ${shortDayMonthLabel(formatKyivDayLabel(queryAnchor, kyivToday()))}`;
  }
  if (queryKind === "earlier" && queryAnchor) {
    return `Вільні дні до ${shortDayMonthLabel(formatKyivDayLabel(queryAnchor, kyivToday()))}`;
  }
  return AVAILABILITY_GENERIC_DATE_HEADING;
};

const headingForSnapshot = (snapshot: AvailabilityRenderSnapshot): string =>
  availabilityDateHeading(snapshot.queryKind, snapshot.queryAnchor);

const emptyBody = (snapshot: AvailabilityRenderSnapshot): string => {
  if (snapshot.emptyMode === "earlier") {
    return "Раніших вільних дат не знайшли. Пошукати пізніші дати?";
  }
  if (snapshot.emptyMode === "exact") {
    return "На цю дату вільного часу немає. Пошукати іншу дату?";
  }
  return "У цьому періоді вільного часу немає. Пошукати інші дати?";
};

const dateSelectBody = (interaction: DateSelectInteraction): string => {
  const { snapshot } = interaction;
  if (snapshot.emptyMode != null) {
    return emptyBody(snapshot);
  }
  const bullets = snapshot.days
    .map((day) => {
      const hours = day.slotSummaries.join(", ");
      return `  - ${day.displayLabel}: ${hours}`;
    })
    .join("\n");
  return `${headingForSnapshot(snapshot)} 🗓️\n\n${bullets}\n\nЯкий день вам зручний?`;
};

const timeSelectBody = (interaction: TimeSelectInteraction): string => {
  const day = interaction.snapshot.days.find((entry) => entry.date === interaction.date)
    ?? interaction.snapshot.days[0];
  const dayLabel = day?.displayLabel ?? interaction.date;
  const labels = day?.slotSummaries ?? [];
  const bullets = labels.map((label) => `  - ${label}`).join("\n");
  return `${AVAILABILITY_TIME_HEADING}${dayLabel} 🗓️\n\n${bullets}\n\nЯкий час вам зручний?`;
};

const serviceConfirmBody = (interaction: PendingInteraction & { kind: "service_confirm" }): string => {
  const acceptLabel = interaction.choices.find((choice) => choice.id === "accept")?.label;
  const english = acceptLabel === BOOKING_OFFER_MENU_EN[0];
  if (interaction.service.id === CONSULTATION_SERVICE_ID) {
    return english ? SERVICE_CONFIRM_CONSULTATION_EN : SERVICE_CONFIRM_CONSULTATION_UK;
  }
  const name = interaction.service.name ?? interaction.service.id;
  return english
    ? SERVICE_CONFIRM_PROCEDURE_EN(name)
    : SERVICE_CONFIRM_PROCEDURE_UK(name);
};

const clarificationBody = (interaction: PendingInteraction): string => {
  // Skip stays on the reply keyboard only — in-message bullets make free-text notes look like a picker.
  if (interaction.kind === "visit_note") {
    return BOOKING_NOTE_QUESTION_UK;
  }
  if (interaction.kind === "service_confirm") {
    return serviceConfirmBody(interaction);
  }
  if (interaction.kind === "date_select") {
    return dateSelectBody(interaction);
  }
  if (interaction.kind === "time_select") {
    return timeSelectBody(interaction);
  }
  if (interaction.kind === "visit_select") {
    if (interaction.stage === "replacement") {
      return "У вас уже є запланований візит. Скасувати його й записати новий?";
    }
    if (interaction.stage === "meeting") {
      return interaction.action === "cancel"
        ? "Який візит скасувати?"
        : "Який візит перенести?";
    }
    return "Чим можу допомогти з вашим записом?";
  }
  if (interaction.kind === "contact_field") {
    if (interaction.occupied) {
      return BOOKING_PHONE_OCCUPIED_UK;
    }
    if (interaction.field === "firstName") {
      return "Підкажіть, будь ласка, ваше ім’я.";
    }
    if (interaction.field === "lastName") {
      return "Підкажіть, будь ласка, ваше прізвище.";
    }
    return BOOKING_PHONE_QUESTION_UK;
  }
  if (interaction.kind === "mutation_confirm") {
    return "Підтвердити цю дію?";
  }
  const options = choiceBullets(interaction);
  if (interaction.kind === "service_or_note") {
    const service = interaction.currentService.name ?? interaction.currentService.id;
    const intro =
      `Ви обрали «${service}». Ваше повідомлення також може означати зміну послуги.`;
    return options.length > 0 ? `${intro}\n\n${options}` : `${intro}\n\nОберіть, будь ласка:`;
  }
  if (interaction.kind === "service_candidate") {
    // FAQ browse body is renderFaqCatalogReply in FAQ finalize, not this renderer.
    return options.length > 0
      ? `${SERVICE_CHANGE_ACK_UK}\n\n${options}`
      : SERVICE_CHANGE_ACK_UK;
  }
  if (interaction.kind === "catalog_detour") {
    return options;
  }
  return options;
};

/** Build a fresh AIMessage from the open interaction. Never reuse stale agentMessages. */
export const renderBookingInteractionMessage = (
  interaction: PendingInteraction,
): AIMessage =>
  new AIMessage(clarificationBody(interaction));

export const replyButtonsForInteraction = (
  interaction: PendingInteraction,
): string[] => interaction.choices.map((choice) => choice.label);

/** Stable identity for an availability snapshot used by DATE/TIME interactions. */
export const availabilitySnapshotId = (context: AvailabilityContext): string => {
  const query = availabilityQueryFromContext(context);
  const days = context.days.map((day) => day.date).join(",");
  return [
    context.serviceId ?? "",
    query?.kind ?? "",
    query?.anchor ?? query?.date ?? "",
    days,
    String(context.stepMinutes),
  ].join("|");
};

const renderDayFromContext = (
  day: AvailabilityContext["days"][number],
): AvailabilityRenderSnapshot["days"][number] => {
  const displayLabel = day.dayLabel ?? day.date;
  return {
    date: day.date,
    displayLabel,
    slotSummaries: day.slots.map((slot) => slot.label),
    slots: day.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      dateStart: slot.dateStart,
      dateEnd: slot.dateEnd,
    })),
  };
};

export const availabilityRenderSnapshotFromContext = (
  context: AvailabilityContext,
  days: AvailabilityContext["days"],
  empty?: AvailabilityRenderSnapshot["emptyMode"],
  canSearchEarlier?: boolean,
): AvailabilityRenderSnapshot => {
  const query = availabilityQueryFromContext(context);
  return {
    snapshotId: availabilitySnapshotId(context),
    ...(query?.kind != null ? { queryKind: query.kind } : {}),
    ...(query?.anchor != null
      ? { queryAnchor: query.anchor }
      : query?.date != null
        ? { queryAnchor: query.date }
        : query?.rangeFrom != null
          ? { queryAnchor: query.rangeFrom }
          : {}),
    days: days.map(renderDayFromContext),
    ...(empty != null ? { emptyMode: empty } : {}),
    ...(canSearchEarlier != null ? { canSearchEarlier } : {}),
  };
};

/** DATE interaction from a multi-day availability snapshot. */
export const buildDateSelectInteraction = (
  context: AvailabilityContext,
): DateSelectInteraction => {
  // Projector caps day chips; snapshot lists all open days for message bullets.
  const open = context.days.filter((day) => day.slots.length > 0);
  const snapshot = availabilityRenderSnapshotFromContext(context, open);
  const query = availabilityQueryFromContext(context);
  const presentation = projectAvailabilityPresentation(
    open.map((day) => ({
      date: day.date,
      ...(day.dayLabel != null ? { dayLabel: day.dayLabel } : {}),
      slots: day.slots.map((slot) => ({ id: slot.id, label: slot.label })),
    })),
    {
      snapshotId: snapshot.snapshotId
        || presentationSnapshotId({
          ...(context.serviceId != null ? { serviceId: context.serviceId } : {}),
          ...(query?.kind != null ? { queryKind: query.kind } : {}),
          days: open,
          stepMinutes: context.stepMinutes,
        }),
    },
  );
  return {
    kind: "date_select",
    snapshot,
    choices: (presentation?.choices ?? []).map((choice) => ({
      id: choice.id,
      label: choice.label,
    })),
  };
};

/** TIME interaction from a single-day availability snapshot. */
export const buildTimeSelectInteraction = (
  context: AvailabilityContext,
  day: AvailabilityContext["days"][number],
): TimeSelectInteraction => {
  const snapshot = availabilityRenderSnapshotFromContext(context, [day]);
  const query = availabilityQueryFromContext(context);
  const presentation = projectAvailabilityPresentation(
    [{
      date: day.date,
      ...(day.dayLabel != null ? { dayLabel: day.dayLabel } : {}),
      slots: day.slots.map((slot) => ({ id: slot.id, label: slot.label })),
    }],
    {
      selectedDate: day.date,
      snapshotId: snapshot.snapshotId
        || presentationSnapshotId({
          ...(context.serviceId != null ? { serviceId: context.serviceId } : {}),
          ...(query?.kind != null ? { queryKind: query.kind } : {}),
          days: [day],
          stepMinutes: context.stepMinutes,
        }),
    },
  );
  return {
    kind: "time_select",
    date: day.date,
    snapshot,
    choices: (presentation?.choices ?? []).map((choice) => ({
      id: choice.id,
      label: choice.label,
    })),
  };
};

/** Empty-window DATE interaction (earlier/later prompts). */
export const buildEmptyAvailabilityInteraction = (
  context: AvailabilityContext,
): DateSelectInteraction => {
  const query = availabilityQueryFromContext(context);
  const direction = query?.kind;
  const anchor = query?.anchor ?? query?.rangeFrom ?? context.days[0]?.date;
  const canSearchEarlier =
    direction !== "earlier"
    && anchor != null
    && anchor > kyivToday();

  const emptyMode =
    direction === "earlier"
      ? "earlier" as const
      : direction === "exact"
        ? "exact" as const
        : "other" as const;
  const snapshot = availabilityRenderSnapshotFromContext(context, [], emptyMode, canSearchEarlier);
  const presentation = projectEmptyAvailabilityPresentation(snapshot.snapshotId, {
    direction: direction ?? "other",
    canSearchEarlier,
  });
  return {
    kind: "date_select",
    snapshot,
    choices: presentation.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
    })),
  };
};


/** Heading for a DATE page, derived from the runtime-owned search query. */
export const formatAvailabilityHeading = (context: AvailabilityContext): string => {
  const query = availabilityQueryFromContext(context);
  const anchor = query?.kind === "later" || query?.kind === "earlier"
    ? query.anchor
    : undefined;
  return availabilityDateHeading(query?.kind, anchor);
};

const renderedAvailabilityOffer = (
  interaction: DateSelectInteraction | TimeSelectInteraction,
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction | TimeSelectInteraction } => ({
  replyText: String(renderBookingInteractionMessage(interaction).content),
  replyButtons: replyButtonsForInteraction(interaction),
  interaction,
});

/** DATE offer from a multi-day availability snapshot (code-owned when the model invents hours). */
export const formatAvailabilityDateOffer = (
  contextOrDays: AvailabilityContext | AvailabilityContext["days"],
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction } => {
  const context: AvailabilityContext = Array.isArray(contextOrDays)
    ? { days: contextOrDays, stepMinutes: CLINIC_SLOT_MINUTES }
    : contextOrDays;
  const interaction = buildDateSelectInteraction(context);
  return { ...renderedAvailabilityOffer(interaction), interaction };
};

/** TIME offer from a single-day availability snapshot. */
export const formatAvailabilityTimeOffer = (
  day: AvailabilityContext["days"][number],
  context?: AvailabilityContext,
): { replyText: string; replyButtons: string[]; interaction: TimeSelectInteraction } => {
  const availability: AvailabilityContext = context ?? {
    days: [day],
    stepMinutes: CLINIC_SLOT_MINUTES,
  };
  const interaction = buildTimeSelectInteraction(availability, day);
  return { ...renderedAvailabilityOffer(interaction), interaction };
};

export const formatAvailabilityEmptyOffer = (
  context: AvailabilityContext,
): { replyText: string; replyButtons: string[]; interaction: DateSelectInteraction } => {
  const interaction = buildEmptyAvailabilityInteraction(context);
  return { ...renderedAvailabilityOffer(interaction), interaction };
};

/** Match a patient day pick to a snapshot day (keyboard short label, dayLabel, or YYYY-MM-DD). */
export const matchAvailabilityDay = (
  humanText: string,
  days: AvailabilityContext["days"],
): AvailabilityContext["days"][number] | null => {
  const trimmed = humanText.trim();
  if (!trimmed || isOtherDateChip(trimmed)) {
    return null;
  }
  const normalized = trimmed.toLowerCase();
  for (const day of days) {
    if (day.slots.length === 0) {
      continue;
    }
    const dayLabel = day.dayLabel ?? day.date;
    const short = shortDayMonthLabel(dayLabel);
    if (
      trimmed === day.date
      || trimmed === dayLabel
      || trimmed === short
      || normalized === dayLabel.toLowerCase()
      || normalized === short.toLowerCase()
    ) {
      return day;
    }
  }
  // Telegram users often type only the day number after DATE buttons are shown.
  // Resolve it only against the trusted snapshot and only when it is unique;
  // never invent a month or silently choose between two matching months.
  const bareDay = /^(\d{1,2})$/.exec(trimmed);
  if (bareDay) {
    const wanted = Number(bareDay[1]);
    const matches = days.filter(
      (day) => day.slots.length > 0 && Number(day.date.slice(8, 10)) === wanted,
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
  }
  return null;
};

/** Kept with availability recovery copy; unused until a caller needs the slot-required prompt. */
const BOOKING_SLOT_REQUIRED_UK =
  "Будь ласка, спочатку оберіть дату й час із запропонованих варіантів.";
void BOOKING_SLOT_REQUIRED_UK;

/**
 * When present_availability_slots ran this turn, replace invented DATE/TIME copy with the
 * snapshot. Multi-day → DATE; one day → TIME. Returns null when this turn is not a slot offer.
 */
type AvailabilityOfferResult = {
  replyText: string;
  replyButtons: string[];
  interaction: DateSelectInteraction | TimeSelectInteraction;
};

const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

export const availabilityOfferFromToolTurn = (
  messages: BaseMessage[],
): AvailabilityOfferResult | null => {
  if (!availabilitySlotsRanThisTurn(messages)) {
    return null;
  }
  const captured = captureAvailabilityFromMessages(messages);
  if (!captured) {
    return null;
  }
  const open = captured.days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return formatAvailabilityEmptyOffer(captured);
  }
  if (open.length === 1) {
    return formatAvailabilityTimeOffer(open[0]!, captured);
  }
  return formatAvailabilityDateOffer(captured);
};

/**
 * Code-owned DATE/TIME for booking finalize: TIME when the latest human message picks a
 * snapshot day (even if this-turn present_availability_slots returned a multi-day DATE);
 * else DATE/TIME from this-turn tool snapshot.
 */
export const resolveAvailabilityOffer = (
  messages: BaseMessage[],
  availabilityContext: AvailabilityContext | null | undefined,
  allowCheckpointDayPick = true,
): AvailabilityOfferResult | null => {
  const captured = captureAvailabilityFromMessages(messages);
  const context = captured ?? availabilityContext ?? null;
  const days = context?.days ?? [];
  const day = allowCheckpointDayPick
    ? matchAvailabilityDay(lastHumanText(messages), days)
    : null;
  if (day && context != null) {
    return formatAvailabilityTimeOffer(day, context);
  }
  if (day) {
    return formatAvailabilityTimeOffer(day);
  }
  return availabilityOfferFromToolTurn(messages);
};

/**
 * Re-render trusted checkpoint availability from draft phase + selectedDate.
 * Ignores the human line. Refuses when the snapshot belongs to another service.
 */
export const availabilityRecoveryOffer = (
  state: ClinicState,
): AvailabilityOfferResult | null => {
  const availability = state.availabilityContext;
  if (!availability) {
    return null;
  }
  if (!availabilityMatchesBooking(availability, state.bookingDraft)) {
    return null;
  }
  const selectedDate = state.bookingDraft?.selectedDate;
  const selectedDay = selectedDate == null
    ? undefined
    : availability.days.find((day) => day.date === selectedDate);
  if (selectedDay && selectedDay.slots.length > 0) {
    return formatAvailabilityTimeOffer(selectedDay, availability);
  }
  const open = availability.days.filter((day) => day.slots.length > 0);
  if (open.length === 0) {
    return formatAvailabilityEmptyOffer(availability);
  }
  return formatAvailabilityDateOffer(availability);
};

export const SLOT_JUST_TAKEN_PREFIX = "На жаль, обраний час щойно зайняли.\n\n";


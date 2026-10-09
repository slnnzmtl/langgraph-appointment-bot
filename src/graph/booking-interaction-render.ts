import { AIMessage } from "@langchain/core/messages";

import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_UK,
  EARLIER_DATE_LABEL,
  LATER_DATE_LABEL,
  OTHER_DATE_LABEL,
  SERVICE_CHANGE_ACK_UK,
} from "../shared/clinic-constants.js";
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

const headingForSnapshot = (snapshot: AvailabilityRenderSnapshot): string => {
  if (snapshot.queryKind === "nearest") {
    return AVAILABILITY_DATE_HEADING;
  }
  const anchor = snapshot.queryAnchor;
  if (snapshot.queryKind === "later" && anchor) {
    return `Вільні дні після ${shortDayMonthLabel(formatKyivDayLabel(anchor, kyivToday()))}`;
  }
  if (snapshot.queryKind === "earlier" && anchor) {
    return `Вільні дні до ${shortDayMonthLabel(formatKyivDayLabel(anchor, kyivToday()))}`;
  }
  return AVAILABILITY_GENERIC_DATE_HEADING;
};

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
  const name = interaction.service.name ?? interaction.service.id;
  if (name.toLowerCase().includes("консультац")) {
    return "Підібрати вільний час на консультацію?";
  }
  return `Чудово, обрано: ${name}. Бажаєте записатися на цю процедуру?`;
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

const snapshotFromContext = (
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
  const open = context.days.filter((day) => day.slots.length > 0).slice(0, 3);
  const snapshot = snapshotFromContext(context, open);
  return {
    kind: "date_select",
    snapshot,
    choices: [
      ...open.map((day) => ({
        id: day.date,
        label: shortDayMonthLabel(day.dayLabel ?? day.date),
      })),
      { id: "other_date", label: OTHER_DATE_LABEL },
    ],
  };
};

/** TIME interaction from a single-day availability snapshot. */
export const buildTimeSelectInteraction = (
  context: AvailabilityContext,
  day: AvailabilityContext["days"][number],
): TimeSelectInteraction => {
  const snapshot = snapshotFromContext(context, [day]);
  return {
    kind: "time_select",
    date: day.date,
    snapshot,
    choices: [
      ...day.slots.slice(0, 3).map((slot) => ({
        id: slot.id,
        label: slot.label,
      })),
      { id: "other_date", label: OTHER_DATE_LABEL },
    ],
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

  if (direction === "earlier") {
    const snapshot = snapshotFromContext(context, [], "earlier");
    return {
      kind: "date_select",
      snapshot,
      choices: [{ id: "later", label: LATER_DATE_LABEL }],
    };
  }

  if (direction === "exact") {
    const snapshot = snapshotFromContext(context, [], "exact", canSearchEarlier);
    return {
      kind: "date_select",
      snapshot,
      choices: [
        ...(canSearchEarlier ? [{ id: "earlier", label: EARLIER_DATE_LABEL }] : []),
        { id: "later", label: LATER_DATE_LABEL },
      ],
    };
  }

  const snapshot = snapshotFromContext(context, [], "other", canSearchEarlier);
  return {
    kind: "date_select",
    snapshot,
    choices: [
      ...(canSearchEarlier ? [{ id: "earlier", label: EARLIER_DATE_LABEL }] : []),
      { id: "later", label: LATER_DATE_LABEL },
    ],
  };
};


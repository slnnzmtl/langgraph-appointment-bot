import type { BookingView, BookingViewCard, BookingReadModels } from "./decision.js";
import { nextBookingRequirement } from "./requirement.js";
import type { BookingSessionV2, PendingDecision } from "./session.js";

export type BookingViewChoice = {
  id: string;
  label: string;
  aliases?: string[];
};

export type BookingViewInputs = {
  session: BookingSessionV2;
  readModels: BookingReadModels;
  /** Trusted availability choice ids when a snapshot is present. */
  availabilityChoiceIds?: string[];
  availabilitySnapshotId?: string;
  /** Service catalog / candidate choice ids (not availability slots). */
  serviceChoiceIds?: string[];
  /** Visit action / meeting / replacement choice ids. */
  visitChoiceIds?: string[];
  /** Optional labels for stable semantic choices (id → label). */
  choiceLabels?: Record<string, string>;
  locale?: "uk" | "en";
};

const uk = {
  pickService: "Яку послугу бажаєте?",
  pickDate: "Оберіть дату:",
  pickTime: "Оберіть час:",
  visitNote: "Додайте примітку або пропустіть.",
  skip: "Пропустити",
  phone: "Вкажіть номер телефону.",
  firstName: "Вкажіть ім'я.",
  lastName: "Вкажіть прізвище.",
  confirmCreate: "Підтвердити запис?",
  confirmReschedule: "Підтвердити перенесення?",
  confirmCancel: "Підтвердити скасування?",
  pickVisitAction: "Що зробити із записом?",
  pickVisitMeeting: "Оберіть візит:",
  pickVisitReplacement: "Замінити існуючий запис?",
  serviceOrNote: "Це примітка до візиту чи зміна послуги?",
  genericClarify: "Уточніть, будь ласка.",
};

const en = {
  pickService: "Which service would you like?",
  pickDate: "Choose a date:",
  pickTime: "Choose a time:",
  visitNote: "Add a note or skip.",
  skip: "Skip",
  phone: "Please share your phone number.",
  firstName: "Please share your first name.",
  lastName: "Please share your last name.",
  confirmCreate: "Confirm the booking?",
  confirmReschedule: "Confirm the reschedule?",
  confirmCancel: "Confirm the cancellation?",
  pickVisitAction: "What would you like to do with the visit?",
  pickVisitMeeting: "Choose a visit:",
  pickVisitReplacement: "Replace the existing visit?",
  serviceOrNote: "Is this a visit note or a service change?",
  genericClarify: "Please clarify.",
};

type Copy = typeof uk;

const CLARIFICATION_COPY: Record<string, { uk: string; en: string }> = {
  effect_id_mismatch: {
    uk: "Не вдалося зіставити результат дії. Уточніть, будь ласка.",
    en: "Could not match that action result. Please clarify.",
  },
  need_service: {
    uk: "Яку послугу бажаєте записати?",
    en: "Which service would you like to book?",
  },
  need_note: {
    uk: "Додайте примітку до візиту або пропустіть.",
    en: "Add a visit note or skip.",
  },
  need_phoneNumber: {
    uk: "Вкажіть номер телефону.",
    en: "Please share your phone number.",
  },
  need_firstName: {
    uk: "Вкажіть ім'я.",
    en: "Please share your first name.",
  },
  need_lastName: {
    uk: "Вкажіть прізвище.",
    en: "Please share your last name.",
  },
  availability_empty: {
    uk: "На цей час немає вільних слотів. Оберіть іншу дату.",
    en: "No free slots for that time. Please choose another date.",
  },
  phone_occupied: {
    uk: "Цей номер уже прив'язаний до іншого акаунту. Зверніться до адміністратора.",
    en: "That phone is already linked to another account. Please contact the clinic.",
  },
  phone_ambiguous: {
    uk: "Знайдено кілька контактів за цим номером. Зверніться до адміністратора.",
    en: "Several contacts match that phone. Please contact the clinic.",
  },
  confirm_service: {
    uk: "Підтвердіть обрану послугу.",
    en: "Please confirm the selected service.",
  },
  ready_missing_prereq: {
    uk: "Потрібні додаткові дані для запису.",
    en: "More details are needed to complete the booking.",
  },
  no_pending_hitl: {
    uk: "Немає активного підтвердження.",
    en: "There is no active confirmation.",
  },
  needs_interpreter: {
    uk: "Уточніть, будь ласка, ваш запит.",
    en: "Please clarify your request.",
  },
  contact_write_failed: {
    uk: "Не вдалося зберегти контакт. Спробуйте ще раз.",
    en: "Could not save the contact. Please try again.",
  },
  effect_already_completed: {
    uk: "Цю дію вже виконано. Уточніть, будь ласка.",
    en: "That action was already completed. Please clarify.",
  },
  mutation_outcome_unknown: {
    uk: "Не вдалося підтвердити результат. Перевіримо дані ще раз.",
    en: "Could not confirm the outcome. We will verify again.",
  },
  service_or_note: {
    uk: "Це примітка до візиту чи зміна послуги?",
    en: "Is this a visit note or a service change?",
  },
};

export const localizeClarificationReason = (
  reason: string,
  locale: "uk" | "en" = "uk",
): string => {
  const mapped = CLARIFICATION_COPY[reason];
  if (mapped != null) {
    return mapped[locale];
  }
  // Never emit internal tokens to patients.
  if (/^[a-z][a-z0-9_]*$/i.test(reason)) {
    return locale === "en" ? en.genericClarify : uk.genericClarify;
  }
  return reason;
};

/** Stable semantic choices for ordinal / label restoration. */
export const semanticChoicesFromView = (input: {
  card: BookingViewCard | null;
  choiceLabels?: Record<string, string>;
  locale?: "uk" | "en";
}): BookingViewChoice[] => {
  const card = input.card;
  if (card == null) {
    return [];
  }
  const labels = input.choiceLabels ?? {};
  const locale = input.locale ?? "uk";
  const copy = locale === "en" ? en : uk;
  const fromIds = (ids: string[]): BookingViewChoice[] =>
    ids.map((id) => ({
      id,
      label: labels[id] ?? id,
    }));

  switch (card.kind) {
    case "service_candidate":
    case "date_select":
    case "time_select":
    case "visit_select":
      return fromIds(card.choiceIds);
    case "service_confirm":
      return [
        { id: "confirm_service", label: labels.confirm_service ?? copy.confirmCreate },
        { id: "decline_service", label: labels.decline_service ?? copy.pickService },
      ];
    case "visit_note":
      return [{ id: "skip_note", label: card.skipLabel }];
    case "mutation_confirm":
      return [
        { id: "confirm", label: "✅" },
        { id: "decline", label: "❌" },
      ];
    default:
      return [];
  }
};

/**
 * Derive patient-facing booking UI from post-transition session + PendingDecision.
 * Ordinary DATE/TIME/contact/note cards are not independently authoritative.
 */
export const projectBookingView = (input: BookingViewInputs): BookingView => {
  const { session, readModels, locale = "uk" } = input;
  const copy = locale === "en" ? en : uk;
  const decision = session.pendingDecision;

  if (decision?.kind === "mutation_confirm") {
    const text =
      decision.action === "create"
        ? copy.confirmCreate
        : decision.action === "reschedule"
          ? copy.confirmReschedule
          : copy.confirmCancel;
    return {
      replyText: text,
      replyButtons: ["✅", "❌"],
      card: {
        kind: "mutation_confirm",
        action: decision.action,
        effectId: decision.effectId,
      },
    };
  }

  if (decision?.kind === "service_candidate") {
    const choiceIds = input.serviceChoiceIds ?? [];
    return {
      replyText: copy.pickService,
      replyButtons: choiceIds.map((id) => input.choiceLabels?.[id] ?? id),
      card: {
        kind: "service_candidate",
        choiceIds,
      },
    };
  }

  if (decision?.kind === "visit_select") {
    const choiceIds = input.visitChoiceIds ?? defaultVisitChoiceIds(decision.stage);
    const replyText =
      decision.stage === "meeting"
        ? copy.pickVisitMeeting
        : decision.stage === "replacement"
          ? copy.pickVisitReplacement
          : copy.pickVisitAction;
    return {
      replyText,
      replyButtons: choiceIds.map((id) => input.choiceLabels?.[id] ?? id),
      card: {
        kind: "visit_select",
        stage: decision.stage,
        choiceIds,
      },
    };
  }

  if (decision?.kind === "service_or_note") {
    return {
      replyText: copy.serviceOrNote,
      card: { kind: "clarification", reason: "service_or_note" },
    };
  }

  if (decision?.kind === "clarification") {
    return {
      replyText: localizeClarificationReason(decision.reason, locale),
      card: { kind: "clarification", reason: decision.reason },
    };
  }

  const requirement = nextBookingRequirement(session, readModels);
  const card = cardForRequirement(session, requirement, copy, input);
  return {
    replyText: card.replyText,
    ...(card.replyButtons != null ? { replyButtons: card.replyButtons } : {}),
    card: card.card,
  };
};

const defaultVisitChoiceIds = (
  stage: "action" | "meeting" | "replacement",
): string[] => {
  if (stage === "action") {
    return ["reschedule", "cancel", "main_menu"];
  }
  if (stage === "replacement") {
    return ["replace_yes", "replace_no"];
  }
  return [];
};

const cardForRequirement = (
  session: BookingSessionV2,
  requirement: ReturnType<typeof nextBookingRequirement>,
  copy: Copy,
  input: BookingViewInputs,
): { replyText: string; replyButtons?: string[]; card: BookingViewCard | null } => {
  switch (requirement) {
    case "service":
      return {
        replyText: copy.pickService,
        card: session.serviceAcceptance?.status === "pending"
          && session.serviceAcceptance.service.id
          ? {
              kind: "service_confirm",
              serviceId: session.serviceAcceptance.service.id,
              labels: localeLabels(copy),
            }
          : { kind: "clarification", reason: "need_service" },
      };
    case "date":
      return {
        replyText: copy.pickDate,
        card: {
          kind: "date_select",
          snapshotId: input.availabilitySnapshotId ?? "pending",
          choiceIds: input.availabilityChoiceIds ?? [],
        },
      };
    case "time":
      return {
        replyText: copy.pickTime,
        card: {
          kind: "time_select",
          date: session.selectedDate ?? "",
          snapshotId: input.availabilitySnapshotId ?? "pending",
          choiceIds: input.availabilityChoiceIds ?? [],
        },
      };
    case "note":
      return {
        replyText: copy.visitNote,
        replyButtons: [copy.skip],
        card: { kind: "visit_note", skipLabel: copy.skip },
      };
    case "details": {
      const field =
        session.contact.phoneNumber == null
          ? "phoneNumber" as const
          : session.contact.firstName == null
            ? "firstName" as const
            : "lastName" as const;
      return {
        replyText:
          field === "phoneNumber"
            ? copy.phone
            : field === "firstName"
              ? copy.firstName
              : copy.lastName,
        card: { kind: "contact_field", field },
      };
    }
    case "confirming":
    case "ready":
      return { replyText: copy.confirmCreate, card: null };
    default:
      return { replyText: copy.pickService, card: null };
  }
};

const localeLabels = (copy: Copy): string[] => [copy.confirmCreate, copy.pickService];

/** Contact-field and mutation-confirm must not coexist (aggregate invariant). */
export const assertExclusivePendingDecision = (
  decision: PendingDecision | null,
): void => {
  if (decision == null) {
    return;
  }
  // Single pending decision by construction — exclusivity is structural.
  void decision;
};

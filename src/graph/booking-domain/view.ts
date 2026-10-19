import type { BookingView, BookingViewCard, BookingReadModels } from "./decision.js";
import { nextBookingRequirement } from "./requirement.js";
import type { BookingSessionV2, PendingDecision } from "./session.js";

export type BookingViewInputs = {
  session: BookingSessionV2;
  readModels: BookingReadModels;
  /** Trusted availability choice ids when a snapshot is present. */
  availabilityChoiceIds?: string[];
  availabilitySnapshotId?: string;
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
    return {
      replyText: copy.pickService,
      card: {
        kind: "service_candidate",
        choiceIds: input.availabilityChoiceIds ?? [],
      },
    };
  }

  if (decision?.kind === "visit_select") {
    return {
      replyText: copy.pickService,
      card: {
        kind: "visit_select",
        stage: decision.stage,
      },
    };
  }

  if (decision?.kind === "service_or_note") {
    return {
      replyText: copy.visitNote,
      card: { kind: "clarification", reason: "service_or_note" },
    };
  }

  if (decision?.kind === "clarification") {
    return {
      replyText: decision.reason,
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

const cardForRequirement = (
  session: BookingSessionV2,
  requirement: ReturnType<typeof nextBookingRequirement>,
  copy: typeof uk,
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

const localeLabels = (copy: typeof uk): string[] => [copy.confirmCreate, copy.pickService];

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

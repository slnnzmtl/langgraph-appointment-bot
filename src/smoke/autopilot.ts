import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  EARLIER_DATE_LABEL,
  INTENT_SKIP_LABEL,
  LATER_DATE_LABEL,
  OTHER_DATE_LABEL,
  SERVICE_OR_NOTE_KEEP_LABEL_UK,
} from "../shared/clinic-constants.js";
import type { PendingInteraction } from "../graph/booking-session.js";

export type AutopilotDecision = "confirm" | "decline";

export type AutopilotOptions = {
  phone: string;
  firstName: string;
  lastName?: string;
  decision: AutopilotDecision;
  /** When set, typed as the visit-note answer instead of tapping skip. */
  noteText?: string;
};

export type AutopilotState = {
  pendingInteraction: PendingInteraction | null;
  /** True when LangGraph is paused on mutation HITL (tasks interrupt). */
  pendingConfirm?: boolean;
};

const NAV_DATE_LABELS = new Set([
  OTHER_DATE_LABEL,
  EARLIER_DATE_LABEL,
  LATER_DATE_LABEL,
]);

const firstSlotChoiceLabel = (interaction: PendingInteraction): string | null => {
  if (interaction.kind !== "date_select" && interaction.kind !== "time_select") {
    return null;
  }
  const choice = interaction.choices.find(
    (entry) =>
      entry.id !== "other_date"
      && entry.id !== "earlier"
      && entry.id !== "later"
      && !NAV_DATE_LABELS.has(entry.label),
  );
  return choice?.label ?? null;
};

/** When the offered page has no bookable chip, page forward instead of stalling. */
const datePageLabel = (interaction: PendingInteraction): string | null => {
  if (interaction.kind !== "date_select" && interaction.kind !== "time_select") {
    return null;
  }
  const later = interaction.choices.find((entry) => entry.id === "later");
  if (later) {
    return later.label;
  }
  const other = interaction.choices.find((entry) => entry.id === "other_date");
  return other?.label ?? null;
};

/**
 * Pure next patient input for the booking ladder from current pendingInteraction.
 * Returns null when the flow needs a scenario-specific choice (or is done).
 */
export const nextAutopilotInput = (
  state: AutopilotState,
  options: AutopilotOptions,
): string | null => {
  const interaction = state.pendingInteraction;
  if (interaction == null) {
    if (state.pendingConfirm) {
      return options.decision === "confirm" ? CONFIRM_YES_LABEL : CONFIRM_NO_LABEL;
    }
    return null;
  }

  switch (interaction.kind) {
    case "service_confirm": {
      const accept = interaction.choices.find((choice) => choice.id === "accept");
      return accept?.label ?? "Так";
    }
    case "date_select":
    case "time_select":
      return firstSlotChoiceLabel(interaction) ?? datePageLabel(interaction);
    case "contact_field": {
      if (interaction.field === "phoneNumber") {
        return options.phone;
      }
      if (interaction.field === "firstName") {
        return options.firstName;
      }
      return options.lastName ?? "Smoke";
    }
    case "visit_note": {
      if (options.noteText?.trim()) {
        return options.noteText.trim();
      }
      const skip = interaction.choices.find((choice) => choice.id === "skip");
      return skip?.label ?? INTENT_SKIP_LABEL;
    }
    case "mutation_confirm":
      // Without a live LangGraph interrupt, ✅ would be a normal message.
      if (!state.pendingConfirm) {
        return null;
      }
      return options.decision === "confirm" ? CONFIRM_YES_LABEL : CONFIRM_NO_LABEL;
    case "service_or_note": {
      const keep = interaction.choices.find((choice) => choice.id === "keep_service");
      return keep?.label ?? SERVICE_OR_NOTE_KEEP_LABEL_UK;
    }
    case "visit_select":
    case "service_candidate":
    case "catalog_detour":
      return null;
    default:
      return null;
  }
};

import type { PendingInteraction, VisitSelectInteraction } from "../booking-session.js";

/** Structured open interaction for the supervisor routing model. */
export const formatOpenInteractionContext = (
  interaction: PendingInteraction | null | undefined,
): string => {
  if (interaction == null) {
    return "<open_interaction>none</open_interaction>";
  }
  const payload = {
    kind: interaction.kind,
    ...(interaction.kind === "visit_select"
      ? { stage: interaction.stage, action: interaction.action }
      : {}),
    choices: interaction.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
    })),
  };
  return `<open_interaction>${JSON.stringify(payload)}</open_interaction>`;
};

/**
 * Model-mapped choiceId the supervisor may apply itself: only visit menu /
 * meeting picker choices. Every other interaction is owned by its specialist.
 */
export const supervisorOwnedChoiceId = (
  interaction: PendingInteraction | null | undefined,
  choiceId: string | undefined,
): { interaction: VisitSelectInteraction; choiceId: string } | null => {
  if (
    interaction?.kind !== "visit_select"
    || (interaction.stage !== "action" && interaction.stage !== "meeting")
    || choiceId == null
  ) {
    return null;
  }
  return interaction.choices.some((choice) => choice.id === choiceId)
    ? { interaction, choiceId }
    : null;
};

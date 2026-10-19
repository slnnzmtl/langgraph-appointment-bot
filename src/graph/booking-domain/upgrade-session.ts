import type { PendingDecision, SlotProvenance } from "./session.js";

/**
 * Schema-2 fields applied at the hydration boundary after a successful 0/1 draft
 * canonicalize. Pure data transform — no LangGraph.
 */

export type LegacyInteractionShape = {
  kind: string;
  utterance?: string;
  query?: string;
  noteCandidate?: string;
  currentService?: { id: string };
  stage?: "action" | "meeting" | "replacement";
  action?: "create" | "reschedule" | "cancel";
};

export const pendingDecisionFromLegacyInteraction = (
  interaction: LegacyInteractionShape | null | undefined,
  effectIdSeed: string,
): PendingDecision | null => {
  if (interaction == null) {
    return null;
  }
  switch (interaction.kind) {
    case "service_candidate":
      return {
        kind: "service_candidate",
        ...(interaction.utterance != null ? { utterance: interaction.utterance } : {}),
        ...(interaction.query != null ? { query: interaction.query } : {}),
      };
    case "visit_select":
      return {
        kind: "visit_select",
        stage: interaction.stage ?? "action",
        ...(interaction.action === "reschedule" || interaction.action === "cancel"
          ? { action: interaction.action }
          : {}),
      };
    case "service_or_note":
      if (interaction.noteCandidate == null || interaction.currentService?.id == null) {
        return { kind: "clarification", reason: "incomplete_service_or_note" };
      }
      return {
        kind: "service_or_note",
        noteCandidate: interaction.noteCandidate,
        currentServiceId: interaction.currentService.id,
      };
    case "mutation_confirm":
      if (
        interaction.action !== "create"
        && interaction.action !== "reschedule"
        && interaction.action !== "cancel"
      ) {
        return null;
      }
      return {
        kind: "mutation_confirm",
        action: interaction.action,
        effectId: effectIdSeed,
      };
    default:
      return null;
  }
};

export type Schema2DraftFields = {
  slotProvenance: SlotProvenance | null;
  /** Legacy caches are not proof — clear evidence on 0/1 → 2 upgrade. */
  clearSlotEvidence: boolean;
  pendingDecision: PendingDecision | null;
  /** When true, clear frozen pendingCommand (expired legacy HITL). */
  clearPendingCommand: boolean;
  expireLegacyHitl: boolean;
};

export const schema2FieldsForUpgradedDraft = (input: {
  selectedSlot: { dateStart: string } | null | undefined;
  pendingCommand: unknown;
  pendingDecision: PendingDecision | null;
}): Schema2DraftFields => {
  const hadFrozenCommand = input.pendingCommand != null;
  const slotProvenance: SlotProvenance | null =
    input.selectedSlot != null ? "unverified_legacy" : null;
  return {
    slotProvenance,
    clearSlotEvidence: input.selectedSlot != null,
    // Do not keep mutation_confirm without a live interrupt — expire it.
    pendingDecision: hadFrozenCommand
      ? null
      : (input.pendingDecision?.kind === "mutation_confirm" ? null : input.pendingDecision),
    clearPendingCommand: hadFrozenCommand,
    expireLegacyHitl: hadFrozenCommand,
  };
};

/** Apply schema-2 ownership fields onto a canonicalized draft. */
export const withSchema2SessionFields = <T extends {
  version: number;
  selectedSlot: { dateStart: string } | null;
  pendingCommand: unknown;
  pendingDecision?: PendingDecision | null;
  slotProvenance?: SlotProvenance | null;
  slotEvidence?: unknown;
}>(
  draft: T,
  interaction: LegacyInteractionShape | null | undefined,
): T & {
  slotProvenance: SlotProvenance | null;
  slotEvidence: null;
  pendingDecision: PendingDecision | null;
  pendingCommand: T["pendingCommand"] | null;
} => {
  const fromInteraction = pendingDecisionFromLegacyInteraction(
    interaction,
    `legacy_mutation_${draft.version}`,
  );
  const fields = schema2FieldsForUpgradedDraft({
    selectedSlot: draft.selectedSlot,
    pendingCommand: draft.pendingCommand,
    pendingDecision: draft.pendingDecision ?? fromInteraction,
  });
  return {
    ...draft,
    slotProvenance: fields.slotProvenance,
    slotEvidence: null,
    pendingDecision: fields.pendingDecision,
    pendingCommand: fields.clearPendingCommand ? null : draft.pendingCommand,
  };
};

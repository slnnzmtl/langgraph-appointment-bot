import { z } from "zod";

import {
  MAIN_MENU_LABEL,
  SUPERVISOR_OWNED_REPLY_LABELS,
} from "../shared/clinic-constants.js";
import type { SelectedBookingSlot } from "./types.js";
import type {
  BookingSessionEvent,
  PendingInteraction,
} from "./pending-interaction.js";

export const NOTE_TURN_KINDS = [
  "note_provided",
  "note_skipped",
  "service_change_requested",
  "service_or_note_clarification_required",
  "schedule_change_requested",
  "leave_booking",
  "unresolved",
] as const;

export type NoteTurnKind = (typeof NOTE_TURN_KINDS)[number];

export type NoteTurnClassification = {
  kind: NoteTurnKind;
  query?: string;
};

export const noteTurnClassificationSchema = z.object({
  kind: z.enum(NOTE_TURN_KINDS),
  query: z.string().min(1).optional(),
}).strict();

export type ClassifyNoteTurn = (input: {
  patientText: string;
  currentServiceName?: string;
}) => Promise<NoteTurnClassification>;

export type NoteTurnScheduleMatch =
  | { type: "date_selected"; date: string }
  | { type: "slot_selected"; slot: SelectedBookingSlot }
  | null;

export type InterpretNoteTurnInput = {
  patientText: string;
  pendingInteraction: PendingInteraction | null;
  /** Snapshot-grounded date/slot matcher supplied by the orchestrator. */
  matchSchedule?: (text: string) => NoteTurnScheduleMatch;
  currentServiceName?: string;
  classify: ClassifyNoteTurn;
};

export type InterpretNoteTurnResult =
  | {
      source: "trusted";
      sessionEvent: BookingSessionEvent;
    }
  | {
      source: "classified";
      classification: NoteTurnClassification;
    };

const matchInteractionChoice = (
  patientText: string,
  interaction: PendingInteraction | null,
): { type: "interaction_choice"; choiceId: string } | null => {
  if (interaction == null) {
    return null;
  }
  const trimmed = patientText.trim();
  const choice = interaction.choices.find((entry) => entry.label === trimmed);
  return choice != null ? { type: "interaction_choice", choiceId: choice.id } : null;
};

const isStableMenuLeave = (patientText: string): boolean => {
  const trimmed = patientText.trim();
  return trimmed === MAIN_MENU_LABEL || SUPERVISOR_OWNED_REPLY_LABELS.has(trimmed);
};

/**
 * Interpret one note-phase patient message.
 * Trusted matches never call the classifier. Free-text skip synonyms and all other
 * free text go through classify exactly once.
 */
export const interpretNoteTurn = async (
  input: InterpretNoteTurnInput,
): Promise<InterpretNoteTurnResult> => {
  const patientText = input.patientText.trim();
  if (patientText.length === 0) {
    return { source: "classified", classification: { kind: "unresolved" } };
  }

  const choice = matchInteractionChoice(patientText, input.pendingInteraction);
  if (choice != null) {
    return { source: "trusted", sessionEvent: choice };
  }

  if (isStableMenuLeave(patientText)) {
    return {
      source: "trusted",
      sessionEvent: { type: "leave_booking", destination: "main_menu" },
    };
  }

  const schedule = input.matchSchedule?.(patientText) ?? null;
  if (schedule != null) {
    return { source: "trusted", sessionEvent: schedule };
  }

  let raw: NoteTurnClassification;
  try {
    raw = await input.classify({
      patientText,
      ...(input.currentServiceName != null
        ? { currentServiceName: input.currentServiceName }
        : {}),
    });
  } catch {
    return { source: "classified", classification: { kind: "unresolved" } };
  }

  const parsed = noteTurnClassificationSchema.safeParse(raw);
  if (!parsed.success) {
    return { source: "classified", classification: { kind: "unresolved" } };
  }

  // Classifier leave_booking is only accepted for stable menu labels, which
  // already took the trusted path above. Free-text leave claims are unresolved.
  if (parsed.data.kind === "leave_booking") {
    return { source: "classified", classification: { kind: "unresolved" } };
  }

  const classification: NoteTurnClassification = {
    kind: parsed.data.kind,
    ...(parsed.data.query != null ? { query: parsed.data.query } : {}),
  };
  return { source: "classified", classification };
};

/** Map a validated classification onto session events using the original patient text. */
export const sessionEventFromClassification = (
  classification: NoteTurnClassification,
  originalPatientText: string,
): BookingSessionEvent | { type: "unresolved" } => {
  switch (classification.kind) {
    case "note_provided":
      return { type: "note_provided", value: originalPatientText };
    case "note_skipped":
      return { type: "note_skipped" };
    case "service_change_requested":
      return {
        type: "service_change_requested",
        utterance: originalPatientText,
        ...(classification.query != null ? { query: classification.query } : {}),
      };
    case "service_or_note_clarification_required":
      return {
        type: "service_or_note_opened",
        ...(classification.query != null ? { query: classification.query } : {}),
        noteCandidate: originalPatientText,
        choices: [],
      };
    case "schedule_change_requested":
      return { type: "unresolved" };
    case "leave_booking":
      return { type: "leave_booking", destination: "main_menu" };
    case "unresolved":
    default:
      return { type: "unresolved" };
  }
};

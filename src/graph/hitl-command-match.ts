/**
 * Resume-boundary identity for paused mutation confirms.
 * Compares the full normalized CRM command + effect id.
 */

import type { FrozenMutationCommand } from "./booking-domain/session.js";
import type { BookingDraft } from "./booking-draft.js";

/** Normalize a CRM write payload for stable equality (local ISO + sorted keys). */
export const normalizeCrmCommandPayload = (
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const normalizeValue = (value: unknown): unknown => {
    if (value == null) {
      return value;
    }
    if (typeof value === "string") {
      // Kyiv-local meeting times may arrive with or without seconds.
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
        return `${value}:00`;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeValue(entry));
    }
    if (typeof value === "object") {
      return normalizeCrmCommandPayload(value as Record<string, unknown>);
    }
    return value;
  };

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    out[key] = normalizeValue(payload[key]);
  }
  return out;
};

export const frozenCommandsEqual = (
  left: FrozenMutationCommand | null | undefined,
  right: FrozenMutationCommand | null | undefined,
): boolean => {
  if (left == null || right == null) {
    return false;
  }
  if (left.action !== right.action) {
    return false;
  }
  if (left.effectId.length === 0 || right.effectId.length === 0) {
    return false;
  }
  if (left.effectId !== right.effectId) {
    return false;
  }
  return (
    JSON.stringify(normalizeCrmCommandPayload(left.payload))
    === JSON.stringify(normalizeCrmCommandPayload(right.payload))
  );
};

export type ConfirmBookingInterruptDraft = {
  type?: string;
  draft?: {
    command?: {
      action?: string;
      payload?: Record<string, unknown>;
    };
    name?: string;
    dateStart?: string;
    dateEnd?: string;
    confirmMessage?: string;
  };
};

/** Extract a FrozenMutationCommand from a LangGraph confirm_booking interrupt value. */
export const frozenCommandFromInterruptValue = (
  value: unknown,
  effectId: string | undefined,
): FrozenMutationCommand | null => {
  if (value == null || typeof value !== "object") {
    return null;
  }
  const interrupt = value as ConfirmBookingInterruptDraft;
  const command = interrupt.draft?.command;
  if (command == null || command.payload == null) {
    return null;
  }
  const action = command.action;
  if (action !== "create" && action !== "reschedule" && action !== "cancel") {
    return null;
  }
  if (effectId == null || effectId.length === 0) {
    return null;
  }
  return {
    action,
    effectId,
    payload: { ...command.payload },
  };
};

/** Frozen command stored on the draft pendingDecision, if any. */
export const frozenCommandFromDraft = (
  bookingDraft: BookingDraft | null | undefined,
): FrozenMutationCommand | null => {
  const pending = bookingDraft?.pendingDecision;
  if (pending?.kind !== "mutation_confirm") {
    return null;
  }
  if (pending.frozenCommand != null) {
    return pending.frozenCommand;
  }
  // Legacy: reconstruct from pendingCommand + effectId when frozenCommand missing.
  if (bookingDraft == null) {
    return null;
  }
  if (bookingDraft.pendingCommand == null || pending.effectId.length === 0) {
    return null;
  }
  const action = bookingDraft.pendingCommand.action;
  if (action !== "create" && action !== "reschedule" && action !== "cancel") {
    return null;
  }
  return {
    action,
    effectId: pending.effectId,
    payload: { ...bookingDraft.pendingCommand.payload },
  };
};

/**
 * True when the draft's frozen command matches the paused interrupt command.
 * Fail closed when either side is missing.
 */
export const hitlCommandsMatch = (
  bookingDraft: BookingDraft | null | undefined,
  interruptValue: unknown,
): boolean => {
  const fromDraft = frozenCommandFromDraft(bookingDraft);
  if (fromDraft == null) {
    return false;
  }
  const fromInterrupt = frozenCommandFromInterruptValue(
    interruptValue,
    fromDraft.effectId,
  );
  return frozenCommandsEqual(fromDraft, fromInterrupt);
};

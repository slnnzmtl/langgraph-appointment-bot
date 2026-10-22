/**
 * Resume-boundary identity for paused mutation confirms.
 * Compares the full normalized CRM command + correlated effect ids.
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

/**
 * Extract action + payload from a LangGraph confirm_booking interrupt.
 * The paused interrupt has no effect id — never fabricate one from the draft.
 */
export const interruptCommandFromValue = (
  value: unknown,
): { action: "create" | "reschedule" | "cancel"; payload: Record<string, unknown> } | null => {
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
  return {
    action,
    payload: { ...command.payload },
  };
};

/** @deprecated Prefer interruptCommandFromValue — interrupt has no effect id. */
export const frozenCommandFromInterruptValue = (
  value: unknown,
  effectId: string | undefined,
): FrozenMutationCommand | null => {
  const cmd = interruptCommandFromValue(value);
  if (cmd == null || effectId == null || effectId.length === 0) {
    return null;
  }
  return {
    action: cmd.action,
    effectId,
    payload: cmd.payload,
  };
};

/**
 * Stored frozen command only — fail closed when missing.
 * Does not reconstruct from pendingCommand.
 */
export const frozenCommandFromDraft = (
  bookingDraft: BookingDraft | null | undefined,
): FrozenMutationCommand | null => {
  const pending = bookingDraft?.pendingDecision;
  if (pending?.kind !== "mutation_confirm") {
    return null;
  }
  if (pending.frozenCommand == null) {
    return null;
  }
  return pending.frozenCommand;
};

/**
 * True when the draft's frozen command matches the paused interrupt command
 * and all three effect ids agree. Fail closed when any side is missing.
 *
 * Required:
 * 1. stored pendingDecision.frozenCommand
 * 2. pendingEffect present
 * 3. frozenCommand.effectId === pendingDecision.effectId === pendingEffect.id
 * 4. interrupt action + payload equal frozen (independently of effect id)
 */
export const hitlCommandsMatch = (
  bookingDraft: BookingDraft | null | undefined,
  interruptValue: unknown,
): boolean => {
  const pending = bookingDraft?.pendingDecision;
  if (pending?.kind !== "mutation_confirm") {
    return false;
  }
  const frozen = pending.frozenCommand;
  if (frozen == null) {
    return false;
  }
  const pendingEffect = bookingDraft?.pendingEffect;
  if (pendingEffect == null || pendingEffect.id.length === 0) {
    return false;
  }
  if (frozen.effectId.length === 0 || pending.effectId.length === 0) {
    return false;
  }
  if (
    frozen.effectId !== pending.effectId
    || frozen.effectId !== pendingEffect.id
  ) {
    return false;
  }

  const fromInterrupt = interruptCommandFromValue(interruptValue);
  if (fromInterrupt == null) {
    return false;
  }
  if (fromInterrupt.action !== frozen.action) {
    return false;
  }
  return (
    JSON.stringify(normalizeCrmCommandPayload(fromInterrupt.payload))
    === JSON.stringify(normalizeCrmCommandPayload(frozen.payload))
  );
};

/**
 * Single effect → tool mapper + stamp/allowlist for the decide/effect loop.
 */
import { BOOKING_INFORMATIONAL_TOOL_NAMES, isBookingRuntimeToolName } from "../../tools/index.js";
import type { PendingEffect } from "../booking-domain/effects.js";

export const BOOKING_EFFECT_STAMP = "bookingEffectV1" as const;

export type StampedBookingToolCall = {
  id: string;
  name: string;
  action: string;
  args: Record<string, unknown> & { __bookingEffectStamp: typeof BOOKING_EFFECT_STAMP };
};

export const stampBookingEffect = (pending: PendingEffect): StampedBookingToolCall => {
  const name = toolNameForBookingEffect(pending);
  if (
    !isBookingRuntimeToolName(name)
    && !BOOKING_INFORMATIONAL_TOOL_NAMES.has(name)
  ) {
    throw new Error(`Refusing to stamp non-booking tool: ${name}`);
  }
  return {
    id: pending.id,
    name,
    action: pending.effect.kind,
    args: {
      ...toolArgsForEffect(pending),
      __bookingEffectStamp: BOOKING_EFFECT_STAMP,
    },
  };
};

export const assertStampedBookingToolCall = (
  call: { name?: string; args?: Record<string, unknown> },
): void => {
  if (call.args?.__bookingEffectStamp !== BOOKING_EFFECT_STAMP) {
    throw new Error(`Unstamped booking tool call: ${call.name ?? "unknown"}`);
  }
};

/** Tool name expected for a pending booking effect (for result validation). */
export const toolNameForBookingEffect = (pending: PendingEffect): string => {
  switch (pending.effect.kind) {
    case "present_availability":
      return "present_availability_slots";
    case "lookup_contact_by_phone":
      return "find_contact_by_phone";
    case "create_contact":
      return "create_contact";
    case "update_contact":
      return "update_contact";
    case "link_telegram_contact":
      return "link_telegram_to_contact";
    case "create_meeting":
      return "create_meeting";
    case "reschedule_meeting":
      return "reschedule_meeting";
    case "cancel_meeting":
      return "cancel_meeting";
    case "list_services":
      return "list_services";
    case "get_service":
      return "get_service";
    case "get_working_time":
      return "get_working_time";
    default: {
      const _exhaustive: never = pending.effect;
      return _exhaustive;
    }
  }
};

const toolArgsForEffect = (pending: PendingEffect): Record<string, unknown> => {
  const effect = pending.effect;
  switch (effect.kind) {
    case "present_availability":
      return {
        queryKind: effect.queryKind,
        ...(effect.date != null ? { date: effect.date } : {}),
        ...(effect.preferredTime != null ? { preferredTime: effect.preferredTime } : {}),
        ...(effect.revalidate === true ? { revalidate: true } : {}),
      };
    case "lookup_contact_by_phone":
      return { phoneNumber: effect.phoneNumber };
    case "create_contact":
      return { ...effect.payload };
    case "update_contact":
      return { ...effect.payload };
    case "link_telegram_contact":
      return { contactId: effect.contactId };
    case "create_meeting":
    case "reschedule_meeting":
    case "cancel_meeting":
      return { ...effect.payload };
    case "list_services":
      return effect.query != null ? { query: effect.query } : {};
    case "get_service":
      return { serviceId: effect.serviceId };
    case "get_working_time":
      return {};
    default: {
      const _exhaustive: never = effect;
      return _exhaustive;
    }
  }
};

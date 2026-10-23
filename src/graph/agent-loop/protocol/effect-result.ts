/**
 * One ToolMessage → EffectResult translator for booking decide.
 * Reuses existing normalize and classify helpers — no second JSON grammar.
 */
import type { BaseMessage } from "@langchain/core/messages";

import { asJsonRecord } from "../../../shared/json-record.js";
import { extractRawMessageText } from "../../../shared/message-content.js";
import {
  normalizePresentAvailabilityResult,
} from "../../../tools/availability-tools.js";
import {
  contactMissingFields,
  normalizeContactLookupResult,
} from "../../../tools/contact-tools.js";
import { parseListServicesPayload } from "../../../tools/service-tools.js";
import {
  presentationSnapshotId,
  projectAvailabilityPresentation,
} from "../../booking-domain/availability-presentation.js";
import type {
  EffectResult,
  InformationalFacts,
  PendingEffect,
} from "../../booking-domain/effects.js";
import { classifyPhoneLookupResult } from "../contact-command.js";
import { findToolMessageByCallId } from "../../tool-routing.js";
import { toolNameForBookingEffect } from "../stamp-booking-effect.js";
import { classifyMeetingMutationToolMessage } from "./mutation.js";

const INFORMATIONAL_FACT_KEYS = [
  "hours",
  "address",
  "servicePrice",
  "serviceId",
  "serviceName",
] as const satisfies readonly (keyof InformationalFacts)[];

const firstString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

const contactWriteOutcome = (
  name: "create_contact" | "update_contact" | "link_telegram_to_contact",
): "created" | "updated" | "linked" => {
  switch (name) {
    case "create_contact":
      return "created";
    case "update_contact":
      return "updated";
    case "link_telegram_to_contact":
      return "linked";
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
};

/** Copy only allowlisted informational fields; drop raw tool text and unknown keys. */
export const allowlistedInformationalFacts = (
  record: Record<string, unknown> | null,
): InformationalFacts | undefined => {
  if (record == null) {
    return undefined;
  }
  const facts: InformationalFacts = {};
  let saw = false;
  for (const key of INFORMATIONAL_FACT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      facts[key] = value.trim();
      saw = true;
    }
  }
  if (facts.hours == null) {
    const hours =
      typeof record.workingTime === "string"
        ? record.workingTime
        : typeof record.openHours === "string"
          ? record.openHours
          : null;
    if (hours != null && hours.trim().length > 0) {
      facts.hours = hours.trim();
      saw = true;
    }
  }
  if (facts.address == null && typeof record.address === "string" && record.address.trim()) {
    facts.address = record.address.trim();
    saw = true;
  }
  if (facts.servicePrice == null) {
    const price =
      typeof record.total === "string" || typeof record.total === "number"
        ? String(record.total)
        : typeof record.price === "string" || typeof record.price === "number"
          ? String(record.price)
          : null;
    if (price != null && price.trim().length > 0) {
      facts.servicePrice = price.trim();
      saw = true;
    }
  }
  if (facts.serviceName == null && typeof record.name === "string" && record.name.trim()) {
    facts.serviceName = record.name.trim();
    saw = true;
  }
  if (facts.serviceId == null && typeof record.id === "string" && record.id.trim()) {
    facts.serviceId = record.id.trim();
    saw = true;
  }
  return saw ? facts : undefined;
};

/** Fail-closed EffectResult when a matching ToolMessage cannot be trusted. */
export const failClosedForPending = (pending: PendingEffect): EffectResult => {
  const effectId = pending.id;
  switch (pending.effect.kind) {
    case "lookup_contact_by_phone":
      return {
        effectId,
        kind: "contact_lookup",
        outcome: "error",
        phoneNumber: pending.effect.phoneNumber,
      };
    case "present_availability":
      return { effectId, kind: "availability", outcome: "error" };
    case "list_services":
      return { effectId, kind: "catalog", outcome: "error" };
    case "get_working_time":
    case "get_service":
      return { effectId, kind: "informational", outcome: "error" };
    case "create_contact":
    case "update_contact":
    case "link_telegram_contact":
      return { effectId, kind: "contact_write", outcome: "error" };
    case "create_meeting":
      return { effectId, kind: "mutation", action: "create", outcome: "malformed" };
    case "reschedule_meeting":
      return { effectId, kind: "mutation", action: "reschedule", outcome: "malformed" };
    case "cancel_meeting":
      return { effectId, kind: "mutation", action: "cancel", outcome: "malformed" };
    default: {
      const _exhaustive: never = pending.effect;
      return _exhaustive;
    }
  }
};

/**
 * Translate the ToolMessage for {@link pendingEffect} into a typed EffectResult.
 * Passes the trusted pending effect (id + kind + phoneNumber) — never reconstructs
 * the queried phone from draft or AI tool-call args.
 * When a matching ToolMessage exists but cannot be translated, returns fail-closed.
 */
export const effectResultFromToolMessages = (
  messages: BaseMessage[] | undefined,
  pendingEffect: PendingEffect | null,
): EffectResult | null => {
  if (messages == null || pendingEffect == null) {
    return null;
  }
  const expectedEffectId = pendingEffect.id;
  const expectedToolName = toolNameForBookingEffect(pendingEffect);

  const matching = findToolMessageByCallId(messages, expectedEffectId);
  if (matching == null) {
    return null;
  }

  const name = matching.name ?? "";
  if (name !== expectedToolName) {
    return failClosedForPending(pendingEffect);
  }

  // Raw text only — unescapeModelLineBreaks corrupts JSON with \\n in CRM fields.
  const body = extractRawMessageText(matching.content).trim();
  const record = asJsonRecord(body);

  if (name === "present_availability_slots") {
    if (body.startsWith("Error:")) {
      return { effectId: expectedEffectId, kind: "availability", outcome: "error" };
    }
    const availability = normalizePresentAvailabilityResult(body);
    if (availability == null) {
      return { effectId: expectedEffectId, kind: "availability", outcome: "error" };
    }
    const days = availability.days.map((day) => ({
      date: day.date,
      ...(day.dayLabel != null ? { dayLabel: day.dayLabel } : {}),
      slots: day.slots.map((slot) => ({ id: slot.id, label: slot.label })),
    }));
    const slotCount = days.reduce((sum, day) => sum + day.slots.length, 0);
    if (slotCount === 0) {
      return { effectId: expectedEffectId, kind: "availability", outcome: "empty" };
    }
    const query = availability.query;
    const snapshotId = presentationSnapshotId({
      ...(typeof record?.serviceId === "string" ? { serviceId: record.serviceId } : {}),
      ...(query?.kind != null ? { queryKind: query.kind } : {}),
      ...(query?.anchor ?? query?.date ?? query?.rangeFrom
        ? { queryAnchor: query.anchor ?? query.date ?? query.rangeFrom }
        : {}),
      days,
      stepMinutes: availability.stepMinutes,
    });
    const open = days.filter((day) => day.slots.length > 0);
    const selectedDateHint = open.length === 1 ? open[0]?.date : null;
    const presentation = projectAvailabilityPresentation(days, {
      ...(selectedDateHint != null ? { selectedDate: selectedDateHint } : {}),
      snapshotId,
    });
    return {
      effectId: expectedEffectId,
      kind: "availability",
      outcome: "slots",
      snapshotId,
      ...(presentation != null
        ? {
          presentationMode: presentation.mode,
          presentationChoices: presentation.choices,
          ...(presentation.date != null ? { presentationDate: presentation.date } : {}),
        }
        : {}),
    };
  }

  if (name === "find_contact_by_phone") {
    if (pendingEffect.effect.kind !== "lookup_contact_by_phone") {
      return failClosedForPending(pendingEffect);
    }
    const phoneNumber = pendingEffect.effect.phoneNumber;
    // Empty body is malformed (not "none") — require contacts/list shape.
    const normalized = normalizeContactLookupResult(body.length > 0 ? body : "");
    if (normalized.error != null) {
      return {
        effectId: expectedEffectId,
        kind: "contact_lookup",
        outcome: "error",
        phoneNumber,
      };
    }
    const evidence = classifyPhoneLookupResult(normalized.contacts, phoneNumber);
    return {
      effectId: expectedEffectId,
      kind: "contact_lookup",
      outcome: evidence.result,
      contactIds: evidence.contactIds,
      phoneNumber,
    };
  }

  if (
    name === "create_contact"
    || name === "update_contact"
    || name === "link_telegram_to_contact"
  ) {
    const pendingKind = pendingEffect.effect.kind;
    const expectedKind =
      name === "create_contact"
        ? "create_contact" as const
        : name === "update_contact"
          ? "update_contact" as const
          : "link_telegram_contact" as const;
    if (pendingKind !== expectedKind) {
      return failClosedForPending(pendingEffect);
    }
    if (
      body.startsWith("Error:")
      || typeof record?.error === "string"
      || record?.success === false
    ) {
      return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
    }
    const contactId = firstString(record?.id, record?.contactId);
    if (contactId == null) {
      return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
    }
    if (pendingKind === "link_telegram_contact" && contactId !== pendingEffect.effect.contactId) {
      return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
    }
    if (
      pendingKind === "update_contact"
      && (
        contactId !== pendingEffect.effect.payload.contactId
        || record?.id !== pendingEffect.effect.payload.contactId
        || record?.contactId !== pendingEffect.effect.payload.contactId
      )
    ) {
      return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
    }
    if (pendingKind === "update_contact" && record?.success !== true) {
      return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
    }
    const contact = pendingKind === "update_contact"
      ? {
          id: contactId,
          ...Object.fromEntries(
            ["firstName", "lastName", "phoneNumber", "cTelegram"].flatMap((field) =>
              typeof record?.[field] === "string" ? [[field, record[field]]] : [],
            ),
          ),
        }
      : undefined;
    const crmComplete = pendingKind === "update_contact"
      ? contactMissingFields(contact ?? {}).length === 0
      : Array.isArray(record?.missingFields)
        ? record.missingFields.length === 0
        : contactMissingFields(record ?? {}).length === 0;
    return {
      effectId: expectedEffectId,
      kind: "contact_write",
      outcome: contactWriteOutcome(name),
      contactId,
      crmComplete,
      ...(contact ? { contact } : {}),
    };
  }

  if (
    name === "create_meeting"
    || name === "reschedule_meeting"
    || name === "cancel_meeting"
  ) {
    const action =
      name === "create_meeting"
        ? "create" as const
        : name === "reschedule_meeting"
          ? "reschedule" as const
          : "cancel" as const;
    const classified = classifyMeetingMutationToolMessage(matching);
    switch (classified) {
      case "pending_confirmation": {
        const userReply =
          typeof record?.userReply === "string" && record.userReply.trim().length > 0
            ? record.userReply.trim()
            : undefined;
        return {
          effectId: expectedEffectId,
          kind: "mutation",
          action,
          outcome: "pending",
          ...(userReply != null ? { userReply } : {}),
        };
      }
      case "committed":
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "committed" };
      case "declined":
      case "abandoned":
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "declined" };
      case "failed":
      case "blocked":
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "failed" };
      case null:
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "unknown" };
      default: {
        const _exhaustive: never = classified;
        return _exhaustive;
      }
    }
  }

  if (name === "list_services") {
    if (body.startsWith("Error:")) {
      return { effectId: expectedEffectId, kind: "catalog", outcome: "error" };
    }
    const parsed = parseListServicesPayload(body);
    if (parsed == null) {
      return { effectId: expectedEffectId, kind: "catalog", outcome: "error" };
    }
    // Incomplete page (total > returned) — fail closed; do not present a partial family.
    if (parsed.total != null && parsed.total > parsed.list.length) {
      return { effectId: expectedEffectId, kind: "catalog", outcome: "error" };
    }
    const services = parsed.list.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.duration != null && Number.isFinite(row.duration) && row.duration > 0
        ? { durationMinutes: row.duration }
        : {}),
    }));
    if (services.length === 0) {
      return { effectId: expectedEffectId, kind: "catalog", outcome: "empty" };
    }
    return { effectId: expectedEffectId, kind: "catalog", outcome: "ok", services };
  }

  if (name === "get_working_time" || name === "get_service") {
    if (record?.error != null || body.startsWith("Error:")) {
      return { effectId: expectedEffectId, kind: "informational", outcome: "error" };
    }
    const facts = allowlistedInformationalFacts(record);
    return {
      effectId: expectedEffectId,
      kind: "informational",
      outcome: "ok",
      ...(facts != null ? { facts } : {}),
    };
  }

  return failClosedForPending(pendingEffect);
};

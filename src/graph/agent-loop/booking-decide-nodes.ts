/**
 * Thin LangGraph adapters for the decide/effect loop (atomic cutover).
 * Compiled interrupt-capable node name `booking__tools` remains the HITL resume target.
 *
 * decideBooking returns events only; this node applies them exclusively via
 * reduceBookingDraft. Informational tool results are allowlisted facts only.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { Command, Overwrite } from "@langchain/langgraph";
import { FAQ_AGENT_ID } from "../types.js";

import { extractMessageTextContent } from "../../shared/message-content.js";
import { asJsonRecord } from "../../shared/json-record.js";
import {
  reduceBookingDraft,
  type BookingContactField,
  type BookingDraft,
  type BookingEvent,
} from "../booking-draft.js";
import { decideBooking } from "../booking-domain/decide.js";
import type { BookingDecision, BookingReadModels } from "../booking-domain/decision.js";
import {
  presentationSnapshotId,
  projectAvailabilityPresentation,
} from "../booking-domain/availability-presentation.js";
import type {
  EffectResult,
  InformationalFacts,
  PendingEffect,
} from "../booking-domain/effects.js";
import type { UnderstoodBookingTurn } from "../booking-domain/turn.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { findToolMessageByCallId, hasPendingToolCalls } from "../tool-routing.js";
import { availabilityQueryFromContext } from "../../tools/availability-tools.js";
import {
  contactMissingFields,
  normalizeContactLookupResult,
} from "../../tools/contact-tools.js";
import {
  classifyPhoneLookupResult,
  resolveContactIdentity,
} from "../contact-command.js";
import { labelIdFor } from "../../shared/message-content.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
} from "../booking-session.js";
import { choiceIdsFromCard } from "./booking-card-choices.js";
import type { InterpretBookingTurn } from "./booking-turn-interpreter.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import { classifyMeetingMutationToolMessage } from "./protocol/mutation.js";
import { projectPendingInteraction } from "./project-pending-interaction.js";
import {
  appendOrReplacePendingToolCall,
  stampRuntimeToolAi,
} from "./runtime-tool-stamp.js";
import {
  stampBookingEffect,
  toolNameForBookingEffect,
} from "./stamp-booking-effect.js";

export const BOOKING_DECIDE_NODE = "booking__decide" as const;
/** Keep legacy name as the ToolNode / HITL resume target. */
export const BOOKING_EFFECTS_NODE = "booking__tools" as const;

const INFORMATIONAL_FACT_KEYS = [
  "hours",
  "address",
  "servicePrice",
  "serviceId",
  "serviceName",
] as const satisfies readonly (keyof InformationalFacts)[];

const CONTACT_FIELD_SET = new Set<BookingContactField>([
  "phoneNumber",
  "firstName",
  "lastName",
]);

const firstString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

const awaitingContactFieldFromDraft = (
  draft: BookingDraft | null | undefined,
): BookingContactField | undefined => {
  const pending = draft?.pendingDecision;
  if (pending?.kind === "clarification" && typeof pending.reason === "string") {
    const prefix = "need_";
    if (pending.reason.startsWith(prefix)) {
      const field = pending.reason.slice(prefix.length);
      if (CONTACT_FIELD_SET.has(field as BookingContactField)) {
        return field as BookingContactField;
      }
    }
  }
  if (draft?.phase === "details") {
    return "phoneNumber";
  }
  return undefined;
};

const coerceServiceRows = (record: Record<string, unknown> | unknown[] | null): unknown[] => {
  if (record == null) {
    return [];
  }
  if (Array.isArray(record)) {
    return record;
  }
  if (Array.isArray(record.services)) {
    return record.services;
  }
  if (Array.isArray(record.list)) {
    return record.list;
  }
  return [];
};

const serviceNameFromRow = (item: {
  name?: unknown;
  cName?: unknown;
}): string => {
  if (typeof item.name === "string" && item.name.trim().length > 0) {
    return item.name.trim();
  }
  if (typeof item.cName === "string" && item.cName.trim().length > 0) {
    return item.cName.trim();
  }
  return "";
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

const bookingContextWithoutMeeting = (
  bookingContext: ClinicState["bookingContext"],
  meetingId: string | undefined,
): ClinicState["bookingContext"] | undefined => {
  if (
    meetingId == null
    || meetingId.length === 0
    || bookingContext == null
  ) {
    return undefined;
  }
  return {
    ...bookingContext,
    meetings: bookingContext.meetings.filter((meeting) => meeting.id !== meetingId),
  };
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
  // Common CRM shapes → allowlisted keys.
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

const lastHumanText = (messages: BaseMessage[] | undefined): string => {
  if (messages == null) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?._getType?.() === "human") {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

export const readModelsFromClinicState = (state: ClinicState): BookingReadModels => {
  const availability = state.availabilityContext;
  const query = availability != null ? availabilityQueryFromContext(availability) : null;
  const snapshotId = availability != null
    ? presentationSnapshotId({
      ...(availability.serviceId != null ? { serviceId: availability.serviceId } : {}),
      ...(query?.kind != null ? { queryKind: query.kind } : {}),
      ...(query?.anchor ?? query?.date ?? query?.rangeFrom
        ? { queryAnchor: query.anchor ?? query.date ?? query.rangeFrom }
        : {}),
      days: availability.days,
      stepMinutes: availability.stepMinutes,
    })
    : undefined;
  const plannedMeetings = (state.bookingContext?.meetings ?? []).flatMap((meeting) => {
    if (typeof meeting.id !== "string" || meeting.id.trim().length === 0) {
      return [];
    }
    return [{
      id: meeting.id.trim(),
      ...(typeof meeting.name === "string" && meeting.name.trim().length > 0
        ? { name: meeting.name.trim() }
        : {}),
      ...(typeof meeting.dateStart === "string" ? { dateStart: meeting.dateStart } : {}),
      ...(typeof meeting.dateEnd === "string" ? { dateEnd: meeting.dateEnd } : {}),
    }];
  });
  return {
    contactContextDirty: state.prefetchDirty === true,
    bookingContextDirty: state.prefetchDirty === true,
    availabilityVerified: availability != null,
    ...(availability != null
      ? {
        availabilityDays: availability.days.map((day) => ({
          date: day.date,
          ...(day.dayLabel != null ? { dayLabel: day.dayLabel } : {}),
          slots: day.slots.map((slot) => ({
            id: slot.id,
            label: slot.label,
            dateStart: slot.dateStart,
            dateEnd: slot.dateEnd,
          })),
        })),
      }
      : {}),
    ...(snapshotId != null ? { availabilitySnapshotId: snapshotId } : {}),
    ...(plannedMeetings.length > 0 ? { plannedMeetings } : {}),
  };
};

/** Resolve offered slot / catalog choice ids against allowlisted read models. */
export const enrichPatchWithReadModels = (
  patch: UnderstoodBookingTurn,
  state: ClinicState,
  readModels: BookingReadModels,
): UnderstoodBookingTurn => {
  const choiceId =
    patch.scheduleIntent?.kind === "choice"
      ? patch.scheduleIntent.choiceId
      : patch.choice?.choiceId;
  if (choiceId == null) {
    return patch;
  }
  if (choiceId === "other_date" || choiceId === "earlier" || choiceId === "later") {
    return {
      ...patch,
      scheduleIntent: { kind: "choice", choiceId },
    };
  }

  // Catalog service candidate (id was offered from list_services evidence).
  const offered = state.bookingDraft?.offeredChoiceIds ?? [];
  const pendingService = state.bookingDraft?.pendingDecision;
  if (
    offered.includes(choiceId)
    && pendingService?.kind === "service_candidate"
  ) {
    const label = pendingService.labels?.[choiceId];
    const { scheduleIntent: _s, choice: _c, ...rest } = patch;
    return {
      ...rest,
      serviceIntent: {
        kind: "catalog_service",
        serviceId: choiceId,
        ...(label != null ? { serviceName: label } : {}),
      },
    };
  }

  const days = readModels.availabilityDays ?? [];
  for (const day of days) {
    const slot = day.slots.find((s) => s.id === choiceId);
    if (slot != null) {
      const { choice: _c, ...rest } = patch;
      return {
        ...rest,
        scheduleIntent: {
          kind: "slot",
          slot: {
            dateStart: slot.dateStart,
            dateEnd: slot.dateEnd,
            label: slot.label,
          },
          ...(readModels.availabilitySnapshotId != null
            ? { snapshotId: readModels.availabilitySnapshotId }
            : {}),
        },
      };
    }
  }
  return patch;
};

/** Fail-closed EffectResult when a matching ToolMessage cannot be trusted. */
const failClosedForPending = (pending: PendingEffect): EffectResult => {
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

  const body = extractMessageTextContent(matching.content).trim();
  const record = asJsonRecord(body);

  if (name === "present_availability_slots") {
    if (record?.error != null || body.startsWith("Error:")) {
      return { effectId: expectedEffectId, kind: "availability", outcome: "error" };
    }
    const parseSlots = (raw: unknown): Array<{ id: string; label: string }> =>
      Array.isArray(raw)
        ? raw.flatMap((slot) => {
          if (slot == null || typeof slot !== "object") {
            return [];
          }
          const s = slot as { id?: unknown; label?: unknown };
          if (typeof s.id !== "string" || typeof s.label !== "string") {
            return [];
          }
          return [{ id: s.id, label: s.label }];
        })
        : [];
    // Multi-day `{ days }` and single-day `{ date, slots }` shapes (same as normalize).
    const rawDays = Array.isArray(record?.days)
      ? record.days
      : typeof record?.date === "string" && Array.isArray(record?.slots)
        ? [{
          date: record.date,
          ...(typeof record.dayLabel === "string" ? { dayLabel: record.dayLabel } : {}),
          slots: record.slots,
        }]
        : [];
    const days = rawDays.flatMap((day) => {
      if (day == null || typeof day !== "object") {
        return [];
      }
      const row = day as {
        date?: unknown;
        dayLabel?: unknown;
        slots?: unknown;
      };
      if (typeof row.date !== "string") {
        return [];
      }
      return [{
        date: row.date,
        ...(typeof row.dayLabel === "string" ? { dayLabel: row.dayLabel } : {}),
        slots: parseSlots(row.slots),
      }];
    });
    const slotCount = days.reduce((sum, day) => sum + day.slots.length, 0);
    if (slotCount === 0) {
      return { effectId: expectedEffectId, kind: "availability", outcome: "empty" };
    }
    const query = record?.query != null && typeof record.query === "object"
      ? record.query as { kind?: string; anchor?: string; date?: string; rangeFrom?: string }
      : null;
    const snapshotId = typeof record?.snapshotId === "string"
      ? record.snapshotId
      : presentationSnapshotId({
        ...(typeof record?.serviceId === "string" ? { serviceId: record.serviceId } : {}),
        ...(typeof query?.kind === "string" ? { queryKind: query.kind } : {}),
        ...(typeof (query?.anchor ?? query?.date ?? query?.rangeFrom) === "string"
          ? { queryAnchor: String(query?.anchor ?? query?.date ?? query?.rangeFrom) }
          : {}),
        days,
        ...(typeof record?.stepMinutes === "number" ? { stepMinutes: record.stepMinutes } : {}),
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
    const normalized = normalizeContactLookupResult(body.length > 0 ? body : "{}");
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
    const contactId = firstString(record?.id, record?.contactId);
    if (contactId != null) {
      const missingRaw = record?.missingFields;
      const crmComplete = Array.isArray(missingRaw)
        ? missingRaw.filter((entry): entry is string => typeof entry === "string").length === 0
        : contactMissingFields(record ?? {}).length === 0;
      return {
        effectId: expectedEffectId,
        kind: "contact_write",
        outcome: contactWriteOutcome(name),
        contactId,
        crmComplete,
      };
    }
    return { effectId: expectedEffectId, kind: "contact_write", outcome: "failed" };
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
    // One classifier for HITL leave (left+cancelled), ❌ (cancelled), commit, etc.
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
        // Collapse leave and ❌ onto declined; decide maps both to main menu.
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
    if (record?.error != null || body.startsWith("Error:")) {
      return { effectId: expectedEffectId, kind: "catalog", outcome: "error" };
    }
    const services = coerceServiceRows(record).flatMap((row) => {
      if (row == null || typeof row !== "object") {
        return [];
      }
      const item = row as { id?: unknown; name?: unknown; cName?: unknown };
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const serviceName = serviceNameFromRow(item);
      if (id.length === 0 || serviceName.length === 0) {
        return [];
      }
      return [{ id, name: serviceName }];
    });
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

const applyEvents = (
  draft: ClinicState["bookingDraft"],
  events: BookingEvent[],
): ClinicState["bookingDraft"] => {
  let next = draft ?? null;
  for (const event of events) {
    next = reduceBookingDraft(next, event);
  }
  return next;
};

const withOfferedChoices = (
  draft: ClinicState["bookingDraft"],
  decision: BookingDecision,
): { draft: ClinicState["bookingDraft"]; events: BookingEvent[] } => {
  const ids = choiceIdsFromCard(decision.card);
  if (ids.length === 0) {
    if (draft?.offeredChoiceIds != null) {
      return {
        draft: applyEvents(draft, [{ type: "choices_cleared" }]),
        events: [{ type: "choices_cleared" }],
      };
    }
    return { draft, events: [] };
  }
  const event: BookingEvent = { type: "choices_offered", choiceIds: ids };
  return { draft: applyEvents(draft, [event]), events: [event] };
};

export type CreateBookingDecideNodeOptions = {
  interpretTurn?: InterpretBookingTurn;
};

const CONTACT_LADDER_SEED_FIELDS = [
  "phoneNumber",
  "firstName",
  "lastName",
] as const satisfies readonly BookingContactField[];

/**
 * Project telegram-owned prefetch into the draft before decideBooking.
 * Kernel stays draft-only. Always copy known CRM ladder fields into details
 * (needed for meeting title + incomplete-name asks); then contact_resolved.
 * clearDetails is reserved for contact_write when CRM is already complete.
 */
export const seedDraftFromTelegramPrefetch = (
  draft: BookingDraft | null,
  contactContext: ClinicState["contactContext"],
): { draft: BookingDraft | null; events: BookingEvent[] } => {
  if (draft == null || draft.contactId != null) {
    return { draft, events: [] };
  }
  const identity = resolveContactIdentity(contactContext, draft.contactId);
  if (identity.kind !== "owned") {
    return { draft, events: [] };
  }
  const crm = identity.contact;
  const events: BookingEvent[] = [];
  for (const field of CONTACT_LADDER_SEED_FIELDS) {
    const value = crm[field];
    if (typeof value === "string" && value.trim().length > 0) {
      events.push({ type: "contact_field_submitted", field, value: value.trim() });
    }
  }
  events.push({
    type: "contact_resolved",
    contactId: identity.contactId,
  });
  return { draft: applyEvents(draft, events), events };
};

export const createBookingDecideNode = (
  options: CreateBookingDecideNodeOptions = {},
) => {
  const interpretTurn = options.interpretTurn;

  return async (
    state: ClinicState,
  ): Promise<ClinicStateUpdate | Command> => {
    const readModels = readModelsFromClinicState(state);
    const seeded = seedDraftFromTelegramPrefetch(
      state.bookingDraft ?? null,
      state.contactContext,
    );
    const workingDraft = seeded.draft;
    const pendingEffect = workingDraft?.pendingEffect ?? null;
    const toolsStillPending = hasPendingToolCalls(state.agentMessages);

    let effectResult: EffectResult | null = null;
    if (!toolsStillPending && pendingEffect != null) {
      // Open effect: consume a matching ToolMessage, or fail closed.
      // Do not re-interpret patient text («Так») while the fetch is still open.
      effectResult = effectResultFromToolMessages(state.agentMessages, pendingEffect)
        ?? failClosedForPending(pendingEffect);
    }

    let result;
    if (effectResult != null) {
      result = decideBooking(
        workingDraft,
        { source: "effect_result", result: effectResult },
        readModels,
      );
    } else {
      const rawText = lastHumanText(state.messages);
      // Exact main-menu «Записатись» bypasses the structured interpreter.
      if (labelIdFor(rawText) === "mainBook") {
        result = decideBooking(
          workingDraft,
          {
            source: "semantic_patch",
            patch: { serviceIntent: { kind: "consultation" } },
          },
          readModels,
        );
      } else {
        const awaitingContactField = awaitingContactFieldFromDraft(workingDraft);
        // Reply-keyboard taps send labels; inline callbacks send ids.
        // Prefer inboundChoiceId; otherwise map the open card label → choice id.
        const fromInbound = state.inboundChoiceId;
        const fromChip = fromInbound == null
          ? interpretInteractionReply(state.pendingInteraction, rawText)
          : null;
        const callbackChoiceId = fromInbound
          ?? (fromChip?.kind === "choice" ? fromChip.choiceId : undefined);
        const interpretInput = {
          rawText,
          ...(callbackChoiceId != null ? { callbackChoiceId } : {}),
          ...(workingDraft?.offeredChoiceIds != null
            ? { offeredChoiceIds: workingDraft.offeredChoiceIds }
            : {}),
          awaitingNote: workingDraft?.note.status === "awaiting"
            || workingDraft?.phase === "note",
          ...(awaitingContactField != null ? { awaitingContactField } : {}),
          awaitingServiceConfirm: workingDraft?.serviceAcceptance?.status === "pending",
        };
        const rawPatch = interpretTurn != null
          ? await interpretTurn(interpretInput)
          : interpretBookingTurnDeterministic(interpretInput);
        const patch = enrichPatchWithReadModels(rawPatch, {
          ...state,
          bookingDraft: workingDraft,
        }, readModels);
        // Empty interpreter patch with an open draft → decideFromRequirement
        // (cancel seed, note re-ask). Non-empty text without a draft still uses
        // patient_turn → need_interpreter.
        if (Object.keys(patch).length > 0) {
          result = decideBooking(
            workingDraft,
            { source: "semantic_patch", patch },
            readModels,
          );
        } else if (workingDraft != null) {
          result = decideBooking(
            workingDraft,
            { source: "semantic_patch", patch: {} },
            readModels,
          );
        } else {
          result = decideBooking(
            workingDraft,
            { source: "patient_turn", rawText: interpretInput.rawText },
            readModels,
          );
        }
      }
    }

    // workingDraft already includes prefetch seed events when applied.
    let draft = applyEvents(workingDraft, result.events);
    const choicePatch = withOfferedChoices(draft, result.decision);
    draft = choicePatch.draft;

    const pendingInteraction = projectPendingInteraction({
      decision: result.decision,
      draft,
      availabilityContext: state.availabilityContext ?? null,
      previousInteraction: state.pendingInteraction ?? null,
    });

    // Drop the cancelled visit from bookingContext after REPLACE cancel so the
    // next decide/readModels turn does not re-open visit_select/replacement.
    const cancelCompleted = result.events.some(
      (event) => event.type === "cancel_existing_completed",
    );
    const bookingContextAfterCancel = bookingContextWithoutMeeting(
      state.bookingContext,
      cancelCompleted ? workingDraft?.replacement?.meeting.id : undefined,
    );

    // REPLACE cancel with no accepted service → FAQ root catalog.
    if (result.decision.reason === "replacement_cancel_catalog") {
      return new Command({
        goto: "faq__prepare",
        update: {
          bookingDraft: draft,
          bookingSchemaVersion: 2,
          inboundChoiceId: null,
          bookingDecision: null,
          pendingInteraction: null,
          next: FAQ_AGENT_ID,
          lastHandoff: null,
          ...(bookingContextAfterCancel != null
            ? { bookingContext: bookingContextAfterCancel }
            : {}),
          // Keep cancel ToolMessage so FAQ prepare opens the root catalog and
          // finalize can prefix «Запис скасовано.» (Overwrite — do not append).
          agentMessages: new Overwrite(state.agentMessages ?? []),
        },
      });
    }

    // Overwrite the tool tape. `agentMessages: []` is a no-op under the messages
    // reducer, so stale ToolMessages would keep recycled effect ids looking
    // fulfilled and skip booking__tools (date prompt with no chips).
    const update: ClinicStateUpdate = {
      bookingDraft: draft,
      bookingSchemaVersion: 2,
      inboundChoiceId: null,
      bookingDecision: result.decision,
      pendingInteraction,
      agentMessages: new Overwrite([] as BaseMessage[]),
      ...(bookingContextAfterCancel != null
        ? { bookingContext: bookingContextAfterCancel }
        : {}),
    };

    if (
      result.decision.tag === "terminal"
      && (result.decision.intent === "menu" || result.decision.intent === "abandon")
    ) {
      Object.assign(update, closedBookingSessionUpdate(pendingInteraction));
    }

    if (
      (result.decision.tag === "effect" || result.decision.tag === "mutation_confirm")
      && result.decision.pendingEffect != null
    ) {
      const stamped = stampBookingEffect(result.decision.pendingEffect);
      assertStamped(stamped);
      const ai = stampRuntimeToolAi(stamped.name, [{
        id: stamped.id,
        name: stamped.name,
        args: stamped.args,
        type: "tool_call",
      }], stamped.action);
      update.agentMessages = new Overwrite(appendOrReplacePendingToolCall([], ai));
    }

    return update;
  };
};

const assertStamped = (call: { name: string; args: Record<string, unknown> }): void => {
  if (call.args.__bookingEffectStamp !== "bookingEffectV1") {
    throw new Error(`Unstamped booking tool call: ${call.name}`);
  }
};

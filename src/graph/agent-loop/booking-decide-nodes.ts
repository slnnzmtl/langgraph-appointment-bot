/**
 * Thin LangGraph adapters for the decide/effect loop (atomic cutover).
 * Compiled interrupt-capable node name `booking__tools` remains the HITL resume target.
 *
 * decideBooking returns events only; this node applies them exclusively via
 * reduceBookingDraft. Informational tool results are allowlisted facts only.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";

import { extractMessageTextContent } from "../../shared/message-content.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { reduceBookingDraft, type BookingEvent } from "../booking-draft.js";
import { decideBooking } from "../booking-domain/decide.js";
import type { BookingDecision, BookingReadModels } from "../booking-domain/decision.js";
import type { EffectResult, InformationalFacts } from "../booking-domain/effects.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { hasPendingToolCalls } from "../tool-routing.js";
import { choiceIdsFromCard } from "./booking-card-choices.js";
import type { InterpretBookingTurn } from "./booking-turn-interpreter.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import {
  appendOrReplacePendingToolCall,
  stampRuntimeToolAi,
} from "./runtime-tool-stamp.js";
import { stampBookingEffect } from "./stamp-booking-effect.js";

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

export const readModelsFromClinicState = (state: ClinicState): BookingReadModels => ({
  contactContextDirty: state.prefetchDirty === true,
  bookingContextDirty: state.prefetchDirty === true,
  availabilityVerified: state.availabilityContext != null,
});

/**
 * Translate the latest ToolMessage into a typed EffectResult for the kernel.
 * Never lets decideBooking inspect the message tape. Informational results keep
 * only allowlisted facts — never raw tool bodies.
 */
export const effectResultFromToolMessages = (
  messages: BaseMessage[] | undefined,
  expectedEffectId: string | null,
): EffectResult | null => {
  if (messages == null || expectedEffectId == null) {
    return null;
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!(message instanceof ToolMessage)) {
      continue;
    }
    if (message.tool_call_id !== expectedEffectId) {
      continue;
    }
    const name = message.name ?? "";
    const body = extractMessageTextContent(message.content).trim();
    const record = asJsonRecord(body);

    if (name === "present_availability_slots") {
      if (record?.error != null || body.startsWith("Error:")) {
        return { effectId: expectedEffectId, kind: "availability", outcome: "error" };
      }
      const days = Array.isArray(record?.days) ? record.days : [];
      const slotCount = days.reduce((sum: number, day: { slots?: unknown[] }) => (
        sum + (Array.isArray(day.slots) ? day.slots.length : 0)
      ), 0);
      if (slotCount === 0) {
        return { effectId: expectedEffectId, kind: "availability", outcome: "empty" };
      }
      return {
        effectId: expectedEffectId,
        kind: "availability",
        outcome: "slots",
        ...(typeof record?.snapshotId === "string"
          ? { snapshotId: record.snapshotId }
          : {}),
      };
    }

    if (name === "find_contact_by_phone") {
      const outcome = record?.result;
      if (
        outcome === "none"
        || outcome === "single_linkable"
        || outcome === "occupied"
        || outcome === "ambiguous"
      ) {
        const contactIds = Array.isArray(record?.contactIds)
          ? record.contactIds.filter((id): id is string => typeof id === "string")
          : undefined;
        return {
          effectId: expectedEffectId,
          kind: "contact_lookup",
          outcome,
          ...(contactIds != null ? { contactIds } : {}),
        };
      }
      return { effectId: expectedEffectId, kind: "contact_lookup", outcome: "error" };
    }

    if (
      name === "create_contact"
      || name === "update_contact"
      || name === "link_telegram_to_contact"
    ) {
      const contactId =
        typeof record?.id === "string"
          ? record.id
          : typeof record?.contactId === "string"
            ? record.contactId
            : undefined;
      if (contactId != null) {
        return {
          effectId: expectedEffectId,
          kind: "contact_write",
          outcome: name === "create_contact"
            ? "created"
            : name === "update_contact"
              ? "updated"
              : "linked",
          contactId,
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
      if (record?.awaitingConfirmation === true) {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "pending" };
      }
      if (record?.declined === true || record?.error === "declined") {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "declined" };
      }
      if (record?.error != null || body.startsWith("Error:")) {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "failed" };
      }
      if (typeof record?.id === "string" || record?.ok === true) {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "committed" };
      }
      return { effectId: expectedEffectId, kind: "mutation", action, outcome: "unknown" };
    }

    if (
      name === "get_working_time"
      || name === "get_service"
      || name === "list_services"
    ) {
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
  }
  return null;
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

export const createBookingDecideNode = (
  options: CreateBookingDecideNodeOptions = {},
) => {
  const interpretTurn = options.interpretTurn;

  return async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const readModels = readModelsFromClinicState(state);
    const pendingEffectId = state.bookingDraft?.pendingEffect?.id ?? null;
    const effectResult = hasPendingToolCalls(state.agentMessages)
      ? null
      : effectResultFromToolMessages(state.agentMessages, pendingEffectId);

    let result;
    if (effectResult != null) {
      result = decideBooking(
        state.bookingDraft ?? null,
        { source: "effect_result", result: effectResult },
        readModels,
      );
    } else {
      const awaitingContactField =
        state.bookingDraft?.pendingDecision?.kind === "clarification"
        && typeof state.bookingDraft.pendingDecision.reason === "string"
        && state.bookingDraft.pendingDecision.reason.startsWith("need_")
          ? (state.bookingDraft.pendingDecision.reason.replace("need_", "") as
            | "phoneNumber"
            | "firstName"
            | "lastName")
          : state.bookingDraft?.phase === "details"
            ? ("phoneNumber" as const)
            : undefined;
      const interpretInput = {
        rawText: lastHumanText(state.messages),
        ...(state.inboundChoiceId != null
          ? { callbackChoiceId: state.inboundChoiceId }
          : {}),
        ...(state.bookingDraft?.offeredChoiceIds != null
          ? { offeredChoiceIds: state.bookingDraft.offeredChoiceIds }
          : {}),
        awaitingNote: state.bookingDraft?.note.status === "awaiting"
          || state.bookingDraft?.phase === "note",
        ...(awaitingContactField === "phoneNumber"
          || awaitingContactField === "firstName"
          || awaitingContactField === "lastName"
          ? { awaitingContactField }
          : {}),
        awaitingServiceConfirm: state.bookingDraft?.serviceAcceptance?.status === "pending",
      };
      const patch = interpretTurn != null
        ? await interpretTurn(interpretInput)
        : interpretBookingTurnDeterministic(interpretInput);
      result = Object.keys(patch).length > 0
        ? decideBooking(
          state.bookingDraft ?? null,
          { source: "semantic_patch", patch },
          readModels,
        )
        : decideBooking(
          state.bookingDraft ?? null,
          { source: "patient_turn", rawText: interpretInput.rawText },
          readModels,
        );
    }

    let draft = applyEvents(state.bookingDraft ?? null, result.events);
    const choicePatch = withOfferedChoices(draft, result.decision);
    draft = choicePatch.draft;

    const update: ClinicStateUpdate = {
      bookingDraft: draft,
      bookingSchemaVersion: 2,
      inboundChoiceId: null,
      bookingDecision: result.decision,
      agentMessages: [],
    };

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
      }], stamped.action);
      update.agentMessages = appendOrReplacePendingToolCall([], ai);
    }

    return update;
  };
};

const assertStamped = (call: { name: string; args: Record<string, unknown> }): void => {
  if (call.args.__bookingEffectStamp !== "bookingEffectV1") {
    throw new Error(`Unstamped booking tool call: ${call.name}`);
  }
};

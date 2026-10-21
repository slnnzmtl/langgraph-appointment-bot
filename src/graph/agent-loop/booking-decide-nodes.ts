/**
 * Thin LangGraph adapters for the decide/effect loop (atomic cutover).
 * Compiled interrupt-capable node name `booking__tools` remains the HITL resume target.
 *
 * decideBooking returns events only; this node applies them exclusively via
 * reduceBookingDraft. Informational tool results are allowlisted facts only.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { FAQ_AGENT_ID } from "../types.js";

import { extractMessageTextContent, labelIdFor } from "../../shared/message-content.js";
import {
  bookingAvailabilityScope,
  reduceBookingDraft,
  type BookingContactField,
  type BookingDraft,
  type BookingEvent,
} from "../booking-draft.js";
import { decideBooking } from "../booking-domain/decide.js";
import type { BookingDecision, BookingReadModels } from "../booking-domain/decision.js";
import { presentationSnapshotId } from "../booking-domain/availability-presentation.js";
import type { EffectResult } from "../booking-domain/effects.js";
import type { UnderstoodBookingTurn } from "../booking-domain/turn.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { hasPendingToolCalls } from "../tool-routing.js";
import { availabilityQueryFromContext } from "../../tools/availability-tools.js";
import { resolveContactIdentity } from "../contact-command.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
} from "../booking-session.js";
import { choiceIdsFromCard } from "./booking-card-choices.js";
import type { InterpretBookingTurn } from "./booking-turn-interpreter.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import {
  effectResultFromToolMessages,
  failClosedForPending,
} from "./protocol/effect-result.js";
import { availabilitySlotsRanThisTurn, bookingDateAnchors } from "./protocol/availability.js";
import { projectPendingInteraction } from "./project-pending-interaction.js";
import {
  appendOrReplacePendingToolCall,
  stampRuntimeToolAi,
} from "./runtime-tool-stamp.js";
import { stampBookingEffect } from "./stamp-booking-effect.js";

export {
  allowlistedInformationalFacts,
  effectResultFromToolMessages,
  failClosedForPending,
} from "./protocol/effect-result.js";

export const BOOKING_DECIDE_NODE = "booking__decide" as const;
/** Keep legacy name as the ToolNode / HITL resume target. */
export const BOOKING_EFFECTS_NODE = "booking__tools" as const;

const CONTACT_FIELD_SET = new Set<BookingContactField>([
  "phoneNumber",
  "firstName",
  "lastName",
]);


/** Open contact field from the card the patient was shown; else need_* on pendingDecision. */
const awaitingContactField = (
  draft: BookingDraft | null | undefined,
  pendingInteraction: ClinicState["pendingInteraction"],
): BookingContactField | undefined => {
  if (pendingInteraction?.kind === "contact_field") {
    return pendingInteraction.field;
  }
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
  return undefined;
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

const ownedContactFromState = (
  state: ClinicState,
): BookingReadModels["ownedContact"] => {
  const identity = resolveContactIdentity(
    state.contactContext,
    state.bookingDraft?.contactId,
  );
  if (identity.kind !== "owned") {
    return undefined;
  }
  const row = identity.contact;
  const firstName = typeof row.firstName === "string" ? row.firstName.trim() : "";
  const lastName = typeof row.lastName === "string" ? row.lastName.trim() : "";
  if (firstName.length === 0 && lastName.length === 0) {
    return undefined;
  }
  return {
    ...(firstName.length > 0 ? { firstName } : {}),
    ...(lastName.length > 0 ? { lastName } : {}),
  };
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
  const ownedContact = ownedContactFromState(state);
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
    ...(ownedContact != null ? { ownedContact } : {}),
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
  ): Promise<ClinicStateUpdate> => {
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
        const openContactField = awaitingContactField(
          workingDraft,
          state.pendingInteraction,
        );
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
          ...(openContactField != null ? { awaitingContactField: openContactField } : {}),
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

    // REPLACE cancel with no accepted service → FAQ root catalog via
    // compile.ts conditional edges (next === FAQ_AGENT_ID). Keep cancel
    // ToolMessage so FAQ prepare opens the catalog and finalize can prefix
    // «Запис скасовано.» (Overwrite — do not append).
    if (result.decision.reason === "replacement_cancel_catalog") {
      return {
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
        agentMessages: new Overwrite(state.agentMessages ?? []),
      };
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
      const stamped = stampBookingEffect(result.decision.pendingEffect, {
        availabilityContext: state.availabilityContext,
        availabilityCursor: state.availabilityCursor,
        scope: bookingAvailabilityScope(draft),
        anchors: bookingDateAnchors(state),
        availabilityPagedThisTurn: availabilitySlotsRanThisTurn(state.agentMessages ?? []),
      });
      if (stamped != null) {
        assertStamped(stamped);
        const ai = stampRuntimeToolAi(stamped.name, [{
          id: stamped.id,
          name: stamped.name,
          args: stamped.args,
          type: "tool_call",
        }], stamped.action);
        update.agentMessages = new Overwrite(appendOrReplacePendingToolCall([], ai));
      }
    }

    return update;
  };
};

const assertStamped = (call: { name: string; args: Record<string, unknown> }): void => {
  if (call.args.__bookingEffectStamp !== "bookingEffectV1") {
    throw new Error(`Unstamped booking tool call: ${call.name}`);
  }
};

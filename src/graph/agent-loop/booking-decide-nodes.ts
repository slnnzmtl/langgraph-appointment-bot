/**
 * Thin LangGraph adapters for the decide/effect loop (atomic cutover).
 * Compiled interrupt-capable node name `booking__tools` remains the HITL resume target.
 *
 * decideBooking returns events only; this node applies them exclusively via
 * reduceBookingDraft. Informational tool results are allowlisted facts only.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  bookingAvailabilityScope,
  reduceBookingDraft,
  type BookingContactField,
  type BookingDraft,
  type BookingEvent,
} from "../booking/booking-draft.js";
import {
  decideBooking,
} from "../booking-domain/decide.js";
import type { BookingDecision, BookingReadModels } from "../booking-domain/decision.js";
import { presentationSnapshotId } from "../booking-domain/availability-presentation.js";
import type { EffectResult } from "../booking-domain/effects.js";
import type { UnderstoodBookingTurn } from "../booking-domain/turn.js";
import { CATALOG_FAMILY_SELECTOR_QUERY } from "../catalog/catalog-match.js";
import { resolveFaqCatalogChoices } from "../catalog/faq-catalog.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  safeSelect,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "../catalog/service-resolution.js";
import type { CatalogChip } from "../booking-domain/session.js";
import type { InteractionChoice } from "../booking/booking-session.js";
import { hasPendingToolCalls } from "../tool-routing.js";
import { availabilityQueryFromContext } from "../../tools/availability-tools.js";
import { resolveContactIdentity } from "./contact-command.js";
import {
  closedBookingSessionUpdate,
  interpretInteractionReply,
} from "../booking/booking-session.js";
import { choiceIdsFromCard } from "./booking-card-choices.js";
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

export const readModelsFromClinicState = (
  state: ClinicState,
  options?: { assignedUserId?: string },
): BookingReadModels => {
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
  const assignedUserId = options?.assignedUserId?.trim();
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
    ...(assignedUserId != null && assignedUserId.length > 0
      ? { assignedUserId }
      : {}),
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
  /** @deprecated Ingress owns interpret; kept for call-site compat. */
  interpretTurn?: unknown;
  /** Family selector — narrows list_services rows after named_procedure (no stem parsing). */
  selectCandidates?: SelectServiceCandidates;
  /** One-level partitioner for family pages when selector groups are missing. */
  partitionCandidates?: PartitionServiceCandidates;
  /** Espo assigned user — frozen into create_meeting HITL CRM commands. */
  assignedUserId?: string;
};

/** Resolve remaining CRM ids from the active chip page only — not catalogRows. */
const remainingIdsForCatalogChoice = (
  pending: BookingDraft["pendingDecision"],
  choiceId: string,
): string[] => {
  if (pending?.kind !== "service_candidate") {
    return [];
  }
  const chip = pending.choices?.find((entry) => entry.id === choiceId);
  if (chip != null && chip.serviceIds.length > 0) {
    return [...chip.serviceIds];
  }
  return [];
};

const chipsFromInteractionChoices = (choices: InteractionChoice[]): CatalogChip[] =>
  choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    serviceIds: choice.serviceIds != null && choice.serviceIds.length > 0
      ? [...choice.serviceIds]
      : [choice.id],
    ...(choice.displayLabel != null ? { displayLabel: choice.displayLabel } : {}),
  }));

/**
 * Bound every multi-row catalog through the FAQ choice flow (selector →
 * partition → overflow). Named_procedure uses the family selector; bare
 * browse uses FAQ_ROOT_PARTITION_QUERY. Never re-stem in the kernel.
 */
const narrowCatalogWithFamilySelector = async (
  effectResult: EffectResult,
  pendingEffect: BookingDraft["pendingEffect"],
  selectCandidates: SelectServiceCandidates | undefined,
  partitionCandidates: PartitionServiceCandidates | undefined,
): Promise<EffectResult> => {
  if (
    effectResult.kind !== "catalog"
    || effectResult.outcome !== "ok"
    || pendingEffect?.effect.kind !== "list_services"
  ) {
    return effectResult;
  }
  const raw = effectResult.services ?? [];
  if (raw.length === 0) {
    return effectResult;
  }
  const namedQuery = pendingEffect.effect.query?.trim();
  if (namedQuery != null && namedQuery.length > 0) {
    if (selectCandidates == null) {
      return { ...effectResult, services: [] };
    }
    const allowlist = new Map(raw.map((row) => [row.id, row]));
    const selection = await safeSelect(selectCandidates, {
      utterance: namedQuery,
      query: CATALOG_FAMILY_SELECTOR_QUERY,
      candidates: raw.map((row) => ({ id: row.id, name: row.name })),
    });
    const ids = [...new Set(
      (selection?.serviceIds ?? []).filter((id) => allowlist.has(id)),
    )];
    const services = ids.map((id) => allowlist.get(id)!);
    if (services.length <= 1) {
      return { ...effectResult, services };
    }
    const choices = await resolveFaqCatalogChoices({
      services,
      remainingIds: ids,
      utterance: namedQuery,
      query: CATALOG_FAMILY_SELECTOR_QUERY,
      ...(selection?.groups != null ? { groups: selection.groups } : {}),
      ...(partitionCandidates != null ? { partitionCandidates } : {}),
    });
    return {
      ...effectResult,
      services,
      ...(choices.length > 0 ? { choices: chipsFromInteractionChoices(choices) } : {}),
    };
  }
  // Bare browse / «Обрати іншу процедуру»: full list through the same overflow path.
  if (raw.length === 1) {
    return effectResult;
  }
  const ids = raw.map((row) => row.id);
  const choices = await resolveFaqCatalogChoices({
    services: raw,
    remainingIds: ids,
    utterance: FAQ_ROOT_PARTITION_QUERY,
    query: FAQ_ROOT_PARTITION_QUERY,
    ...(partitionCandidates != null ? { partitionCandidates } : {}),
  });
  return {
    ...effectResult,
    services: raw,
    ...(choices.length > 0 ? { choices: chipsFromInteractionChoices(choices) } : {}),
  };
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

type CatalogChipTap =
  | {
      kind: "select";
      serviceId: string;
      serviceName?: string;
    }
  | {
      kind: "page";
      remainingIds: string[];
      choices: CatalogChip[];
    }
  | { kind: "unmatched" };

/**
 * Sole booking catalog-tap resolver against the active card's chips.
 * Does not consult offeredChoiceIds.
 */
const resolveCatalogChipTap = async (
  draft: BookingDraft | null,
  choiceId: string,
  partitionCandidates: PartitionServiceCandidates | undefined,
  utterance: string,
): Promise<CatalogChipTap> => {
  const pending = draft?.pendingDecision;
  if (pending?.kind !== "service_candidate") {
    return { kind: "unmatched" };
  }
  if (pending.choices?.some((entry) => entry.id === choiceId) !== true) {
    return { kind: "unmatched" };
  }
  const remaining = remainingIdsForCatalogChoice(pending, choiceId);
  if (remaining.length === 0) {
    return { kind: "unmatched" };
  }
  if (remaining.length === 1) {
    const serviceId = remaining[0]!;
    const serviceName = pending.catalogRows?.find((row) => row.id === serviceId)?.name;
    return {
      kind: "select",
      serviceId,
      ...(serviceName != null ? { serviceName } : {}),
    };
  }
  const catalogRows = pending.catalogRows ?? [];
  const remainingRows = remaining.flatMap((id) => {
    const row = catalogRows.find((entry) => entry.id === id);
    return row != null ? [row] : [];
  });
  if (remainingRows.length <= 1) {
    if (remainingRows.length === 1) {
      const row = remainingRows[0]!;
      return { kind: "select", serviceId: row.id, serviceName: row.name };
    }
    return { kind: "unmatched" };
  }
  const remainingIds = remainingRows.map((row) => row.id);
  const probe = pending.query ?? utterance;
  const choices = await resolveFaqCatalogChoices({
    services: remainingRows,
    remainingIds,
    utterance: probe,
    ...(pending.query != null ? { query: pending.query } : {}),
    ...(partitionCandidates != null ? { partitionCandidates } : {}),
  });
  return {
    kind: "page",
    remainingIds,
    choices: chipsFromInteractionChoices(choices),
  };
};

const catalogChoiceIdFromState = (
  state: ClinicState,
  draft: BookingDraft | null,
): string | undefined => {
  if (draft?.pendingDecision?.kind !== "service_candidate") {
    return undefined;
  }
  if (state.inboundChoiceId != null && state.inboundChoiceId.length > 0) {
    return state.inboundChoiceId;
  }
  const rawText = lastHumanText(state.messages);
  const fromChip = interpretInteractionReply(state.pendingInteraction, rawText);
  if (fromChip?.kind === "choice") {
    return fromChip.choiceId;
  }
  // Typed text equal to a current chip id (not a buried catalogRows CRM id).
  const trimmed = rawText.trim();
  if (
    trimmed.length > 0
    && draft.pendingDecision.choices?.some((chip) => chip.id === trimmed) === true
  ) {
    return trimmed;
  }
  return undefined;
};

export const createBookingDecideNode = (
  options: CreateBookingDecideNodeOptions = {},
) => {
  void options.interpretTurn;
  const selectCandidates = options.selectCandidates;
  const partitionCandidates = options.partitionCandidates;
  const assignedUserId = options.assignedUserId;

  return async (
    state: ClinicState,
  ): Promise<ClinicStateUpdate> => {
    const readModels = readModelsFromClinicState(state, {
      ...(assignedUserId != null ? { assignedUserId } : {}),
    });
    const seeded = seedDraftFromTelegramPrefetch(
      state.bookingDraft ?? null,
      state.contactContext,
    );
    let workingDraft = seeded.draft;
    const pendingEffect = workingDraft?.pendingEffect ?? null;
    const toolsStillPending = hasPendingToolCalls(state.agentMessages);

    let effectResult: EffectResult | null = null;
    if (!toolsStillPending && pendingEffect != null) {
      // Open effect: consume a matching ToolMessage, or fail closed.
      // Do not re-interpret patient text («Так») while the fetch is still open.
      effectResult = effectResultFromToolMessages(state.agentMessages, pendingEffect)
        ?? failClosedForPending(pendingEffect);
      effectResult = await narrowCatalogWithFamilySelector(
        effectResult,
        pendingEffect,
        selectCandidates,
        partitionCandidates,
      );
    }

    const catalogChoiceId = effectResult == null
      ? catalogChoiceIdFromState(state, workingDraft)
      : undefined;
    const catalogTap = catalogChoiceId != null
      ? await resolveCatalogChipTap(
        workingDraft,
        catalogChoiceId,
        partitionCandidates,
        lastHumanText(state.messages),
      )
      : null;

    let result;
    if (effectResult != null) {
      result = decideBooking(
        workingDraft,
        { source: "effect_result", result: effectResult },
        readModels,
      );
    } else if (catalogTap?.kind === "page") {
      result = decideBooking(
        workingDraft,
        {
          source: "catalog_page",
          remainingIds: catalogTap.remainingIds,
          choices: catalogTap.choices,
        },
        readModels,
      );
    } else if (catalogTap?.kind === "select") {
      result = decideBooking(
        workingDraft,
        {
          source: "semantic_patch",
          patch: {
            serviceIntent: {
              kind: "catalog_service",
              serviceId: catalogTap.serviceId,
              ...(catalogTap.serviceName != null
                ? { serviceName: catalogTap.serviceName }
                : {}),
            },
          },
        },
        readModels,
      );
    } else if (catalogTap?.kind === "unmatched") {
      // Stale/unoffered chip — fail closed; re-ask the open page.
      result = decideBooking(
        workingDraft,
        { source: "semantic_patch", patch: {} },
        readModels,
      );
    } else if (state.understoodTurn != null) {
      // Ingress already classified this utterance — do not interpret again.
      const patch = enrichPatchWithReadModels(state.understoodTurn, {
        ...state,
        bookingDraft: workingDraft,
      }, readModels);
      result = decideBooking(
        workingDraft,
        { source: "semantic_patch", patch },
        readModels,
      );
    } else {
      // HITL resume / effect-only turns: no patient re-interpret at decide.
      // Empty patch re-asks the open requirement when a session exists.
      result = decideBooking(
        workingDraft,
        { source: "semantic_patch", patch: {} },
        readModels,
      );
    }

    // Unstamped present_availability: stamp only returns null for that effect.
    // Apply effect_prepared locally, fail-closed consume, project once.
    if (
      result.decision.tag === "effect"
      && result.decision.pendingEffect?.effect.kind === "present_availability"
    ) {
      const provisional = applyEvents(workingDraft, result.events);
      const stamped = stampBookingEffect(result.decision.pendingEffect, {
        availabilityContext: state.availabilityContext,
        availabilityCursor: state.availabilityCursor,
        scope: bookingAvailabilityScope(provisional),
        anchors: bookingDateAnchors(state),
        availabilityPagedThisTurn: availabilitySlotsRanThisTurn(state.agentMessages ?? []),
      });
      if (stamped == null) {
        const openEffect = provisional?.pendingEffect;
        if (openEffect != null) {
          result = decideBooking(
            provisional,
            {
              source: "effect_result",
              result: failClosedForPending(openEffect),
            },
            readModels,
          );
          // Second decide's events apply on top of provisional (first events kept).
          workingDraft = provisional;
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
      locale: state.patientLocale === "en" ? "en" : "uk",
    });

    // Drop the cancelled visit from bookingContext after REPLACE cancel so the
    // next decide/readModels turn does not re-open visit_select/replacement.
    const cancelCompleted = result.events.some(
      (event) => event.type === "cancel_existing_completed",
    );
    const bookingContextAfterCancel = bookingContextWithoutMeeting(
      state.bookingContext,
      cancelCompleted
        ? (state.bookingDraft ?? workingDraft)?.replacement?.meeting.id
        : undefined,
    );

    // Merge one-shot verified reply facts (deferred price) onto any patient-facing
    // card so booking__respond can prefix them regardless of decision intent.
    let bookingDecision = result.decision;
    const replyFacts = draft?.pendingReplyFacts;
    if (
      replyFacts != null
      && bookingDecision.card != null
      && bookingDecision.tag !== "effect"
    ) {
      bookingDecision = {
        ...bookingDecision,
        facts: {
          ...replyFacts,
          ...bookingDecision.facts,
        },
      };
    }

    // Overwrite the tool tape. `agentMessages: []` is a no-op under the messages
    // reducer, so stale ToolMessages would keep recycled effect ids looking
    // fulfilled and skip booking__tools (date prompt with no chips).
    const update: ClinicStateUpdate = {
      bookingDraft: draft,
      bookingSchemaVersion: 2,
      inboundChoiceId: null,
      bookingDecision,
      pendingInteraction,
      understoodTurn: null,
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
      // Unstamped non-mutation already consumed above; do not restore a card here.
    }

    return update;
  };
};

const assertStamped = (call: { name: string; args: Record<string, unknown> }): void => {
  if (call.args.__bookingEffectStamp !== "bookingEffectV1") {
    throw new Error(`Unstamped booking tool call: ${call.name}`);
  }
};

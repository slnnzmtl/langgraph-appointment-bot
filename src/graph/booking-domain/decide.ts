import {
  CLINIC_ADDRESS,
  CONSULTATION_SERVICE_ID,
  CONSULTATION_SERVICE_NAME_UK,
  CREATE_CONFIRMATION_UK,
} from "../../shared/clinic-constants.js";
import {
  isConfirmationAffirmation,
  isConfirmationDecline,
} from "../../shared/message-content.js";
import { cancelCommandFromMeeting } from "../booking/cancel-command.js";
import {
  availabilityRequestFieldsFromDraft,
  effectiveBookingContactDetails,
  nextMissingContactField,
  reduceBookingDraft,
  slotEvidenceForSelection,
  type BookingContactDetails,
  type BookingDraft,
  type BookingEvent,
  type DeferredBookingTurn,
  type DeferredInformationalRequest,
  type DeferredScheduleRequest,
  type ReplacementMeeting,
} from "../booking/booking-draft.js";
import type {
  BookingDecision,
  BookingInput,
  BookingReadModels,
  BookingSemanticIntent,
  BookingVerifiedFacts,
  BookingViewCard,
  DecideBookingResult,
} from "./decision.js";
import {
  buildCancelMeetingCrmPayload,
  buildCreateMeetingCrmPayload,
  buildRescheduleMeetingCrmPayload,
} from "../../tools/meeting-crm-command.js";
import {
  labelsFromPresentation,
  projectAvailabilityPresentation,
  projectEmptyAvailabilityPresentation,
} from "./availability-presentation.js";
import type { BookingEffect, EffectResult, PendingEffect } from "./effects.js";
import { nextBookingRequirement } from "./requirement.js";
import type { CatalogChip, CatalogRow, PendingDecision } from "./session.js";
import type { ScheduleIntent, UnderstoodBookingTurn } from "./turn.js";
import {
  catalogChipsFromInteractionChoices,
  fallbackCatalogPageChoices,
} from "../catalog/catalog-page-choices.js";

const CONTACT_INTENT: Record<"phoneNumber" | "firstName" | "lastName", BookingSemanticIntent> = {
  phoneNumber: "ask_phone",
  firstName: "ask_first_name",
  lastName: "ask_last_name",
};

/** Last-resort page when the node did not attach FAQ-bounded choices. */
const chipsFromCatalogRows = (rows: readonly CatalogRow[]): CatalogChip[] =>
  catalogChipsFromInteractionChoices(fallbackCatalogPageChoices(rows));

const uniqueAllowlistedIds = (
  ids: readonly string[],
  allowlist: ReadonlyMap<string, CatalogRow>,
): string[] => [...new Set(ids.filter((id) => allowlist.has(id)))];

const catalogCardFromChips = (
  chips: readonly CatalogChip[],
): Extract<BookingViewCard, { kind: "service_candidate" }> => ({
  kind: "service_candidate",
  choices: catalogChipsFromInteractionChoices(chips),
});

type RelativeOrNavSchedule =
  | Extract<ScheduleIntent, { kind: "relative" }>
  | Extract<ScheduleIntent, { kind: "choice" }>;

const queryKindFromSchedule = (
  schedule: RelativeOrNavSchedule,
): "nearest" | "earlier" | "later" => {
  if (schedule.kind === "relative") {
    return schedule.queryKind;
  }
  if (schedule.choiceId === "earlier") {
    return "earlier";
  }
  if (schedule.choiceId === "later" || schedule.choiceId === "other_date") {
    return "later";
  }
  return "nearest";
};

const dateFromSchedule = (
  schedule: RelativeOrNavSchedule,
  working: BookingDraft | null | undefined,
): string | undefined => {
  if (schedule.kind === "relative" && schedule.anchor != null) {
    return schedule.anchor;
  }
  return working?.selectedDate ?? undefined;
};

const newBookingAttemptId = (version: number, clinicDay: string): string =>
  `attempt_v${version}_${clinicDay.replace(/-/g, "")}`;

const deferredScheduleFromPatch = (
  patch: UnderstoodBookingTurn,
): DeferredScheduleRequest | undefined => {
  const schedule = patch.scheduleIntent;
  if (schedule == null) {
    return undefined;
  }
  if (schedule.kind === "date") {
    return { date: schedule.date };
  }
  if (schedule.kind === "time") {
    return { preferredTime: schedule.time };
  }
  if (schedule.kind === "date_and_time") {
    return { date: schedule.date, preferredTime: schedule.time };
  }
  if (schedule.kind === "relative") {
    return {
      relative: schedule.queryKind,
      ...(schedule.anchor != null ? { date: schedule.anchor } : {}),
    };
  }
  return undefined;
};

const deferredInformationalFromPatch = (
  patch: UnderstoodBookingTurn,
): DeferredInformationalRequest | undefined => {
  const question = patch.informationalQuestion?.trim();
  if (question == null || question.length === 0) {
    return undefined;
  }
  const topic = patch.faqTopic
    ?? (question === "hours" || question.includes("hour") || question.includes("годин")
      ? "hours"
      : question === "address" || question.includes("address") || question.includes("адрес")
        ? "address"
        : question === "price" || question.includes("price") || question.includes("цін")
          ? "price"
          : "other");
  return { question, topic };
};

const isExplicitBookingStart = (patch: UnderstoodBookingTurn): boolean => {
  const service = patch.serviceIntent?.kind;
  return (
    service === "named_procedure"
    || service === "consultation"
    || service === "catalog_service"
    || (service === "catalog_browse" && patch.scheduleIntent != null)
    || (patch.scheduleIntent != null && service != null)
  );
};

/**
 * Active booking view from the draft. An open pendingDecision wins; a pending
 * service offer or awaiting note supplies a derived wait only when it does not.
 */
const viewCardFromPendingDecision = (
  draft: BookingDraft | null | undefined,
): BookingViewCard | null => {
  if (draft == null) {
    return null;
  }
  const pending = draft.pendingDecision;
  if (pending?.kind === "service_candidate" && (pending.choices?.length ?? 0) > 0) {
    return catalogCardFromChips(pending.choices!);
  }
  if (pending?.kind === "date_select") {
    return {
      kind: "date_select",
      snapshotId: pending.snapshotId,
      choiceIds: [...pending.choiceIds],
      labels: { ...pending.labels },
      ...(pending.emptyMode != null ? { emptyMode: pending.emptyMode } : {}),
    };
  }
  if (pending?.kind === "time_select") {
    return {
      kind: "time_select",
      date: pending.date,
      snapshotId: pending.snapshotId,
      choiceIds: [...pending.choiceIds],
      labels: { ...pending.labels },
    };
  }
  if (pending?.kind === "visit_select") {
    return { kind: "visit_select", stage: pending.stage };
  }
  if (pending?.kind === "mutation_confirm") {
    return {
      kind: "mutation_confirm",
      action: pending.action,
      effectId: pending.effectId,
    };
  }
  // Derived waits — only when pendingDecision is not an open card.
  if (draft.serviceAcceptance?.status === "pending") {
    const service = draft.serviceAcceptance.service;
    // Choice ids only — localized labels belong in projection/composer.
    return {
      kind: "service_confirm",
      serviceId: service.id,
      choiceIds: ["offer_accept", "offer_choose_other"],
    };
  }
  // Note step may store pendingDecision as clarification/need_note; ask card is visit_note.
  if (draft.note.status === "awaiting") {
    return { kind: "visit_note", skipChoiceId: "note_skip" };
  }
  return null;
};

/** Ask decision that re-shows the open card (unstamped-effect resume). */
export const askDecisionFromPendingView = (
  draft: BookingDraft | null | undefined,
): BookingDecision | null => {
  const card = viewCardFromPendingDecision(draft);
  if (card == null) {
    return null;
  }
  if (card.kind === "service_confirm") {
    const facts: BookingVerifiedFacts = { serviceId: card.serviceId };
    const name = draft?.serviceAcceptance?.service.name;
    if (name != null) facts.serviceName = name;
    return { tag: "ask", intent: "confirm_service", facts, card };
  }
  if (card.kind === "date_select") {
    return { tag: "ask", intent: "present_dates", facts: {}, card };
  }
  if (card.kind === "time_select") {
    return { tag: "ask", intent: "present_times", facts: {}, card };
  }
  if (card.kind === "visit_note") {
    return { tag: "ask", intent: "ask_note", facts: {}, card };
  }
  if (card.kind === "service_candidate") {
    return { tag: "ask", intent: "ask_service", facts: {}, card };
  }
  if (card.kind === "visit_select") {
    return {
      tag: "ask",
      intent: "clarification",
      facts: {},
      card,
      ...(card.stage === "replacement" ? { reason: "replacement_offer" } : {}),
    };
  }
  if (card.kind === "mutation_confirm") {
    const intent =
      card.action === "create"
        ? "confirm_create"
        : card.action === "reschedule"
          ? "confirm_reschedule"
          : "confirm_cancel";
    return {
      tag: "mutation_confirm",
      intent,
      facts: { action: card.action, effectId: card.effectId },
      card,
    };
  }
  return null;
};

const sideQuestionReply = (
  facts: BookingVerifiedFacts,
  draft: BookingDraft | null | undefined,
): BookingDecision => ({
  tag: "reply",
  intent: "answer_side_question",
  facts,
  card: viewCardFromPendingDecision(draft),
});

/** Deep structural equality for emit-once effect correlation. */
const sameEffect = (a: BookingEffect, b: BookingEffect): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const localDate = (iso: string): string => iso.slice(0, 10);
const localTime = (iso: string): string => iso.slice(11, 16);

/** Mint present_availability with draft scope (duration + excludeMeetingIds). */
const presentAvailabilityEffect = (
  draft: BookingDraft | null | undefined,
  fields: Omit<
    Extract<BookingEffect, { kind: "present_availability" }>,
    "kind" | "durationMinutes" | "excludeMeetingIds"
  >,
): Extract<BookingEffect, { kind: "present_availability" }> => ({
  kind: "present_availability",
  ...fields,
  ...availabilityRequestFieldsFromDraft(draft),
});

/** Human-readable service label for CRM meeting titles — never a raw CRM id. */
const serviceLabelForMeeting = (w: BookingDraft): string => {
  const accepted = w.serviceAcceptance?.service;
  const named = accepted?.name?.trim();
  if (named != null && named.length > 0) {
    return named;
  }
  if (accepted?.id === CONSULTATION_SERVICE_ID) {
    return CONSULTATION_SERVICE_NAME_UK;
  }
  return "Запис";
};

/** CRM meeting title: "[service name] - [first last]" (service alone if names missing). */
const createMeetingName = (w: BookingDraft, readModels: BookingReadModels): string => {
  const service = serviceLabelForMeeting(w);
  const details = effectiveBookingContactDetails({
    crmContact: readModels.ownedContact ?? null,
    contactDetails: w.contactDetails ?? null,
  });
  const first = details.firstName?.trim() ?? "";
  const last = details.lastName?.trim() ?? "";
  const patient = [first, last].filter((part) => part.length > 0).join(" ");
  return patient.length > 0 ? `${service} - ${patient}` : service;
};

/**
 * Pure booking decision kernel (atomic cutover).
 *
 * NEVER returns a modified draft: it emits a list of {@link BookingEvent}s that
 * the decide node applies via reduceBookingDraft, plus a {@link BookingDecision}
 * carrying a semantic intent, verified facts, and a choice-id card — no prose.
 */
export const decideBooking = (
  draft: BookingDraft | null,
  input: BookingInput,
  readModels: BookingReadModels,
): DecideBookingResult => {
  const events: BookingEvent[] = [];
  const ctx: { working: BookingDraft | null } = { working: draft ?? null };

  const emit = (event: BookingEvent): void => {
    events.push(event);
    ctx.working = reduceBookingDraft(ctx.working, event);
  };

  const emitDecision = (decision: PendingDecision): void => {
    emit({ type: "decision_set", decision });
  };

  const ask = (
    intent: BookingSemanticIntent,
    card: BookingViewCard | null,
    reason?: string,
    facts: BookingVerifiedFacts = {},
  ): BookingDecision => ({
    tag: "ask",
    intent,
    facts,
    card,
    ...(reason != null ? { reason } : {}),
  });

  const persistedCatalogRows = (): CatalogRow[] => {
    const pending = ctx.working?.pendingDecision;
    return pending?.kind === "service_candidate" ? [...(pending.catalogRows ?? [])] : [];
  };

  const openCatalogPage = (
    catalogRows: readonly CatalogRow[],
    chips: readonly CatalogChip[],
    query?: string,
  ): BookingDecision => {
    const card = catalogCardFromChips(chips);
    const priorQuery = ctx.working?.pendingDecision?.kind === "service_candidate"
      ? ctx.working.pendingDecision.query
      : undefined;
    const probe = query ?? priorQuery;
    emitDecision({
      kind: "service_candidate",
      catalogRows: catalogRows.map((row) => ({ ...row })),
      choices: chips.map((chip) => ({
        id: chip.id,
        label: chip.label,
        serviceIds: [...chip.serviceIds],
        ...(chip.displayLabel != null ? { displayLabel: chip.displayLabel } : {}),
      })),
      ...(probe != null ? { query: probe } : {}),
    });
    return ask("ask_service", card, "service_candidates");
  };

  /** Prepare (or reuse, emit-once) a pending effect for `effect`. */
  const preparePendingEffect = (effect: BookingEffect): PendingEffect => {
    const existing = ctx.working?.pendingEffect ?? null;
    if (
      existing != null
      && (existing.status === "prepared" || existing.status === "executing")
      && sameEffect(existing.effect, effect)
    ) {
      if (existing.status === "prepared") {
        emit({ type: "effect_status", status: "executing" });
      }
      return ctx.working?.pendingEffect ?? existing;
    }
    if (existing != null && existing.status === "completed" && sameEffect(existing.effect, effect)) {
      // Completed write must not be re-emitted — caller forces a clarification.
      return existing;
    }
    const version = ctx.working?.version ?? 0;
    const pending: PendingEffect = {
      id: `eff_${version + 1}_${effect.kind}`,
      expectedRevision: version + 1,
      effect,
      status: "prepared",
    };
    emit({ type: "effect_prepared", effect: pending });
    return ctx.working?.pendingEffect ?? pending;
  };

  const runEffect = (
    intent: BookingSemanticIntent,
    effect: BookingEffect,
  ): BookingDecision => {
    const pending = preparePendingEffect(effect);
    return { tag: "effect", intent, facts: {}, card: null, pendingEffect: pending };
  };

  const mutationIntent = (
    action: "create" | "reschedule" | "cancel",
  ): BookingSemanticIntent =>
    action === "create"
      ? "confirm_create"
      : action === "reschedule"
        ? "confirm_reschedule"
        : "confirm_cancel";

  const buildMutationFacts = (
    w: BookingDraft,
    action: "create" | "reschedule" | "cancel",
    effectId: string,
  ): BookingVerifiedFacts => {
    const facts: BookingVerifiedFacts = { action, effectId };
    if (action !== "cancel") {
      const sid = w.serviceAcceptance?.service.id;
      const sname = w.serviceAcceptance?.service.name;
      if (sid != null) facts.serviceId = sid;
      if (sname != null) facts.serviceName = sname;
      if (w.selectedSlot != null) {
        facts.date = localDate(w.selectedSlot.dateStart);
        facts.time = localTime(w.selectedSlot.dateStart);
      }
    }
    return facts;
  };

  const mutationConfirmDecision = (
    w: BookingDraft,
    action: "create" | "reschedule" | "cancel",
    effectId: string,
    pendingEffect?: PendingEffect,
  ): BookingDecision => ({
    tag: "mutation_confirm",
    intent: mutationIntent(action),
    facts: buildMutationFacts(w, action, effectId),
    card: { kind: "mutation_confirm", action, effectId },
    ...(pendingEffect != null ? { pendingEffect } : {}),
  });

  const emitMutationConfirm = (
    effect: Extract<
      BookingEffect,
      { kind: "create_meeting" | "reschedule_meeting" | "cancel_meeting" }
    >,
    action: "create" | "reschedule" | "cancel",
  ): BookingDecision => {
    const w = ctx.working;
    if (w == null) {
      return { tag: "reply", intent: "idle", facts: {}, card: null };
    }
    if (
      action === "reschedule"
      && w.rescheduleTarget?.dateStart != null
      && w.selectedSlot != null
      && localDate(w.selectedSlot.dateStart) === localDate(w.rescheduleTarget.dateStart)
      && localTime(w.selectedSlot.dateStart) === localTime(w.rescheduleTarget.dateStart)
    ) {
      const reason = "reschedule_same_slot";
      emitDecision({ kind: "clarification", reason });
      return ask(
        "clarification",
        { kind: "clarification", reason },
        reason,
        { clarificationReason: reason },
      );
    }
    // Exact-slot revalidate before freezing a create/reschedule write.
    if (
      (action === "create" || action === "reschedule")
      && w.selectedSlot != null
      && (w.slotProvenance !== "availability_tool" || w.slotEvidence?.snapshotId == null)
    ) {
      return runEffect(
        "run_effect",
        presentAvailabilityEffect(w, {
          queryKind: "exact",
          date: w.selectedDate ?? localDate(w.selectedSlot.dateStart),
          preferredTime: localTime(w.selectedSlot.dateStart),
          revalidate: true,
        }),
      );
    }
    const pending = preparePendingEffect(effect);
    if (pending.status === "completed") {
      emitDecision({ kind: "clarification", reason: "effect_already_completed" });
      return ask(
        "clarification",
        { kind: "clarification", reason: "effect_already_completed" },
        "effect_already_completed",
      );
    }
    // Freeze the CRM write the interrupt will execute — not tool args.
    let frozenPayload: Readonly<Record<string, unknown>> | null = null;
    if (effect.kind === "create_meeting") {
      const assignedUserId = readModels.assignedUserId?.trim();
      if (assignedUserId == null || assignedUserId.length === 0) {
        emitDecision({ kind: "clarification", reason: "missing_assigned_user" });
        return ask(
          "clarification",
          { kind: "clarification", reason: "missing_assigned_user" },
          "missing_assigned_user",
        );
      }
      frozenPayload = buildCreateMeetingCrmPayload({
        name: effect.payload.name,
        dateStart: effect.payload.dateStart,
        dateEnd: effect.payload.dateEnd,
        contactId: effect.payload.contactId,
        serviceId: effect.payload.serviceId,
        assignedUserId,
        ...(effect.payload.description != null
          ? { description: effect.payload.description }
          : {}),
      });
    } else if (effect.kind === "reschedule_meeting") {
      frozenPayload = buildRescheduleMeetingCrmPayload({
        meetingId: effect.payload.meetingId,
        dateStart: effect.payload.dateStart,
        dateEnd: effect.payload.dateEnd,
      });
    } else {
      const meetingId = effect.payload.meetingId;
      if (typeof meetingId !== "string" || meetingId.trim().length === 0) {
        emitDecision({ kind: "clarification", reason: "missing_cancel_meeting_id" });
        return ask(
          "clarification",
          { kind: "clarification", reason: "missing_cancel_meeting_id" },
          "missing_cancel_meeting_id",
        );
      }
      frozenPayload = buildCancelMeetingCrmPayload(meetingId.trim());
    }
    emitDecision({
      kind: "mutation_confirm",
      action,
      effectId: pending.id,
      frozenCommand: {
        action,
        effectId: pending.id,
        payload: frozenPayload,
      },
    });
    const w2 = ctx.working ?? w;
    return mutationConfirmDecision(w2, action, pending.id, pending);
  };

  const acceptedContactRepairEffect = (
    contactId: string,
    details: BookingContactDetails,
  ): BookingDecision | null => {
    const crmNames = readModels.ownedContact;
    const missingCrmName = crmNames != null
      ? (crmNames.firstName == null ? "firstName" : crmNames.lastName == null ? "lastName" : null)
      : null;
    if (missingCrmName == null) return null;
    const value = details[missingCrmName];
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return runEffect("run_effect", {
      kind: "update_contact",
      payload: { contactId, [missingCrmName]: value.trim() },
    });
  };

  /** Contact identity ladder. Prefetch may already set contactId (adapter seed). */
  const decideContactDetails = (): BookingDecision => {
    const w = ctx.working;
    if (w == null) {
      return { tag: "reply", intent: "idle", facts: {}, card: null };
    }
    const details: BookingContactDetails = w.contactDetails ?? {};

    // Owned / linked contact: save accepted details that repair CRM incompleteness
    // before booking. Draft details alone are not evidence that CRM was updated.
    if (w.contactId != null) {
      const sync = acceptedContactRepairEffect(w.contactId, details);
      if (sync != null) return sync;
      const missingOwned = nextMissingContactField(details);
      if (missingOwned != null) {
        emitDecision({ kind: "clarification", reason: `need_${missingOwned}` });
        return ask(
          CONTACT_INTENT[missingOwned],
          { kind: "contact_field", field: missingOwned },
          `need_${missingOwned}`,
        );
      }
      return decideFromRequirement();
    }

    const phone = details.phoneNumber?.trim();
    if (phone == null || phone === "") {
      emitDecision({ kind: "clarification", reason: "need_phone" });
      return ask("ask_phone", { kind: "contact_field", field: "phoneNumber" }, "need_phone");
    }

    const lookup = w.phoneLookupEvidence;
    // Always look up once for the accepted phone before asking more names or creating.
    if (lookup == null || lookup.phoneNumber !== phone) {
      return runEffect("run_effect", { kind: "lookup_contact_by_phone", phoneNumber: phone });
    }

    if (lookup.result === "occupied" || lookup.result === "ambiguous") {
      const reason = lookup.result === "occupied" ? "phone_occupied" : "phone_ambiguous";
      emitDecision({ kind: "clarification", reason });
      return ask("clarification", { kind: "clarification", reason }, reason);
    }

    if (
      lookup.result === "single_linkable"
      && lookup.contactIds[0] != null
      && w.contactId !== lookup.contactIds[0]
    ) {
      return runEffect("run_effect", {
        kind: "link_telegram_contact",
        contactId: lookup.contactIds[0],
      });
    }

    const missing = nextMissingContactField(details);
    if (missing != null) {
      emitDecision({ kind: "clarification", reason: `need_${missing}` });
      return ask(CONTACT_INTENT[missing], { kind: "contact_field", field: missing }, `need_${missing}`);
    }

    if (
      lookup.result === "none"
      && w.contactId == null
      && details.phoneNumber != null
      && details.firstName != null
      && details.lastName != null
    ) {
      return runEffect("run_effect", {
        kind: "create_contact",
        payload: {
          phoneNumber: details.phoneNumber,
          firstName: details.firstName,
          lastName: details.lastName,
        },
      });
    }

    emitDecision({ kind: "clarification", reason: "need_lastName" });
    return ask("ask_last_name", { kind: "contact_field", field: "lastName" }, "need_lastName");
  };

  /** Meeting ids to ignore for preemptive REPLACE (just-cancelled REPLACE continue). */
  const replaceGateExcludeIds = new Set<string>();

  const firstPlannedMeeting = (): ReplacementMeeting | null => {
    const row = readModels.plannedMeetings?.find(
      (meeting) => !replaceGateExcludeIds.has(meeting.id.trim()),
    );
    if (row == null || row.id.trim().length === 0) {
      return null;
    }
    return {
      id: row.id.trim(),
      ...(row.name != null ? { name: row.name } : {}),
      ...(row.dateStart != null ? { dateStart: row.dateStart } : {}),
      ...(row.dateEnd != null ? { dateEnd: row.dateEnd } : {}),
    };
  };

  /** Show REPLACE chips; detect existing visit once when not already offered. */
  const askReplacementOffer = (meeting: ReplacementMeeting): BookingDecision => {
    if (ctx.working?.replacement == null) {
      emit({ type: "existing_booking_detected", meeting });
    }
    emitDecision({ kind: "visit_select", stage: "replacement" });
    return {
      tag: "ask",
      intent: "clarification",
      facts: {},
      card: { kind: "visit_select", stage: "replacement" },
      reason: "replacement_offer",
    };
  };

  const decideFromRequirement = (): BookingDecision => {
    const w = ctx.working;
    if (w == null) {
      return { tag: "reply", intent: "idle", facts: {}, card: null };
    }

    // Resume a prepared/executing write without minting a new effect id.
    if (
      w.pendingDecision?.kind === "mutation_confirm"
      && w.pendingEffect != null
      && (w.pendingEffect.status === "prepared" || w.pendingEffect.status === "executing")
    ) {
      return mutationConfirmDecision(
        w,
        w.pendingDecision.action,
        w.pendingEffect.id,
        w.pendingEffect,
      );
    }

    // Replacement offered → chips (not immediate cancel HITL).
    if (w.replacement?.status === "offered") {
      return askReplacementOffer(w.replacement.meeting);
    }

    // Open service confirm / DATE / TIME card — single builder + ask mapper.
    const openCard = viewCardFromPendingDecision(w);
    if (openCard?.kind === "service_confirm") {
      emitDecision({ kind: "clarification", reason: "confirm_service" });
    }
    if (openCard != null) {
      const resumed = askDecisionFromPendingView(w);
      if (resumed != null) {
        return resumed;
      }
    }

    const requirement = nextBookingRequirement(w, readModels);
    switch (requirement) {
      case "service":
        emitDecision({ kind: "clarification", reason: "need_service" });
        return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
      case "date":
      case "time": {
        // Preemptive REPLACE before fetching slots for a new create.
        if (w.mode !== "reschedule" && w.replacement == null) {
          const existing = firstPlannedMeeting();
          if (existing != null) {
            return askReplacementOffer(existing);
          }
        }
        return runEffect(
          requirement === "date" ? "present_dates" : "present_times",
          presentAvailabilityEffect(w, {
            queryKind: w.selectedDate != null ? "exact" : "nearest",
            ...(w.selectedDate != null ? { date: w.selectedDate } : {}),
            ...(w.requestedTime != null ? { preferredTime: w.requestedTime.value } : {}),
          }),
        );
      }
      case "note":
        emitDecision({ kind: "clarification", reason: "need_note" });
        return {
          tag: "ask",
          intent: "ask_note",
          facts: {},
          card: { kind: "visit_note", skipChoiceId: "note_skip" },
        };
      case "details":
        return decideContactDetails();
      case "ready": {
        if (w.contactId != null) {
          const sync = acceptedContactRepairEffect(w.contactId, w.contactDetails ?? {});
          if (sync != null) return sync;
        }
        if (w.mode === "reschedule" && w.rescheduleTarget != null && w.selectedSlot != null) {
          const slotTime = localTime(w.selectedSlot.dateStart);
          return emitMutationConfirm(
            {
              kind: "reschedule_meeting",
              payload: {
                meetingId: w.rescheduleTarget.id,
                dateStart: w.selectedSlot.dateStart,
                dateEnd: w.selectedSlot.dateEnd,
                // Smoke / adapter expect «Підтвердити перенесення візиту на HH:mm?»
                confirmMessage: `Підтвердити перенесення візиту на ${slotTime}?`,
                ...(w.rescheduleTarget.name != null
                  ? { name: w.rescheduleTarget.name }
                  : {}),
              },
            },
            "reschedule",
          );
        }
        if (
          w.serviceAcceptance?.status === "accepted"
          && w.selectedSlot != null
          && w.contactId != null
        ) {
          return emitMutationConfirm(
            {
              kind: "create_meeting",
              payload: {
                serviceId: w.serviceAcceptance.service.id,
                contactId: w.contactId,
                dateStart: w.selectedSlot.dateStart,
                dateEnd: w.selectedSlot.dateEnd,
                name: createMeetingName(w, readModels),
                confirmMessage: CREATE_CONFIRMATION_UK,
                ...(w.note.value ? { description: w.note.value } : {}),
              },
            },
            "create",
          );
        }
        emitDecision({ kind: "clarification", reason: "ready_missing_prereq" });
        return ask(
          "clarification",
          { kind: "clarification", reason: "ready_missing_prereq" },
          "ready_missing_prereq",
        );
      }
      case "confirming":
        if (w.pendingDecision?.kind === "mutation_confirm") {
          return mutationConfirmDecision(w, w.pendingDecision.action, w.pendingDecision.effectId);
        }
        // Supervisor visit-cancel seeds pendingCommand without pendingDecision.
        if (w.pendingCommand?.action === "cancel") {
          return emitMutationConfirm(
            { kind: "cancel_meeting", payload: { ...w.pendingCommand.payload } },
            "cancel",
          );
        }
        return ask(
          "clarification",
          { kind: "clarification", reason: "awaiting_confirm" },
          "awaiting_confirm",
        );
      case "none":
      default:
        return { tag: "reply", intent: "idle", facts: {}, card: null };
    }
  };

  const selectCatalogRow = (row: CatalogRow): BookingDecision => {
    emit({
      type: "service_selected",
      service: {
        id: row.id,
        name: row.name,
        source: "catalog",
        ...(row.durationMinutes != null ? { durationMinutes: row.durationMinutes } : {}),
      },
      accepted: false,
    });
    return decideFromRequirement();
  };

  const applyCatalogPage = (
    remainingIds: readonly string[],
    choices: readonly CatalogChip[],
  ): BookingDecision => {
    const catalogRows = persistedCatalogRows();
    const allowlist = new Map(catalogRows.map((row) => [row.id, row]));
    const remaining = uniqueAllowlistedIds(remainingIds, allowlist);
    if (remaining.length === 0) {
      const captured = askDecisionFromPendingView(ctx.working);
      if (captured != null) {
        return {
          ...captured,
          reason: "need_service",
          facts: { ...captured.facts, clarificationReason: "need_service" },
        };
      }
      emitDecision({ kind: "clarification", reason: "need_service" });
      return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
    }
    if (remaining.length === 1) {
      return selectCatalogRow(allowlist.get(remaining[0]!)!);
    }
    const remainingSet = new Set(remaining);
    const chips = choices.length > 0
      ? choices.map((chip) => ({
        ...chip,
        serviceIds: uniqueAllowlistedIds(chip.serviceIds, allowlist)
          .filter((id) => remainingSet.has(id)),
      })).filter((chip) => chip.serviceIds.length > 0)
      : chipsFromCatalogRows(remaining.map((id) => allowlist.get(id)!));
    return openCatalogPage(catalogRows, chips);
  };

  const applyControl = (intent: "menu" | "abandon" | "handoff"): BookingDecision => {
    if (intent === "abandon") {
      emit({ type: "draft_abandoned" });
      return { tag: "terminal", intent: "abandon", facts: {}, card: null, reason: "abandon" };
    }
    if (intent === "menu") {
      emit({ type: "draft_abandoned" });
      return { tag: "terminal", intent: "menu", facts: {}, card: null, reason: "menu" };
    }
    return { tag: "terminal", intent: "handoff", facts: {}, card: null, reason: "handoff" };
  };

  const applyEffectResult = (result: EffectResult): BookingDecision => {
    const pending = ctx.working?.pendingEffect ?? null;
    if (pending != null && result.effectId !== pending.id) {
      emitDecision({ kind: "clarification", reason: "effect_id_mismatch" });
      return ask(
        "clarification",
        { kind: "clarification", reason: "effect_id_mismatch" },
        "effect_id_mismatch",
      );
    }

    if (result.kind === "informational") {
      emit({ type: "effect_cleared" });
      const facts: BookingVerifiedFacts = {};
      const f = result.facts;
      if (f?.hours != null) facts.hours = f.hours;
      if (f?.address != null) facts.address = f.address;
      if (f?.servicePrice != null) facts.servicePrice = f.servicePrice;
      if (f?.serviceId != null) facts.serviceId = f.serviceId;
      if (f?.serviceName != null) facts.serviceName = f.serviceName;
      // After a deferred price lookup, continue into availability when schedule remains.
      const deferred = ctx.working?.deferredTurn;
      if (
        deferred?.schedule != null
        && ctx.working?.serviceAcceptance?.status === "accepted"
        && pending?.effect.kind === "get_service"
      ) {
        const sched = deferred.schedule;
        if (sched.date != null) {
          emit({
            type: "schedule_requested",
            date: sched.date,
            ...(sched.preferredTime != null ? { preferredTime: sched.preferredTime } : {}),
          });
        }
        emit({ type: "deferred_turn_cleared", reason: "consumed" });
        // Carry verified price across the availability effect; composer consumes it
        // on the final card (including unavailable/error outcomes).
        if (
          facts.servicePrice != null
          || facts.serviceName != null
          || facts.serviceId != null
        ) {
          emit({
            type: "reply_facts_set",
            facts: {
              ...(facts.servicePrice != null ? { servicePrice: facts.servicePrice } : {}),
              ...(facts.serviceName != null ? { serviceName: facts.serviceName } : {}),
              ...(facts.serviceId != null ? { serviceId: facts.serviceId } : {}),
            },
          });
        }
        const queryKind = sched.relative ?? "exact";
        const nextReq = nextBookingRequirement(ctx.working, readModels);
        if (nextReq !== "none") facts.nextStep = nextReq;
        const avail = preparePendingEffect(
          presentAvailabilityEffect(ctx.working, {
            queryKind: queryKind === "exact" ? "exact" : queryKind,
            ...(sched.date != null ? { date: sched.date } : {}),
            ...(sched.preferredTime != null ? { preferredTime: sched.preferredTime } : {}),
          }),
        );
        return {
          tag: "effect",
          intent: "run_effect",
          facts,
          card: null,
          pendingEffect: avail,
        };
      }
      if (deferred?.informational != null && pending?.effect.kind === "get_service") {
        emit({ type: "deferred_informational_consumed" });
      }
      const nextReq = nextBookingRequirement(ctx.working, readModels);
      if (nextReq !== "none") facts.nextStep = nextReq;
      return sideQuestionReply(facts, ctx.working);
    }

    if (result.kind === "catalog") {
      emit({ type: "effect_cleared" });
      // Keep deferred requests across catalog pages; unbind the finished effect.
      if (ctx.working?.deferredTurn != null) {
        emit({ type: "deferred_turn_bound", boundEffectId: null });
      }
      // Node already narrowed via family selector when list_services had a query.
      // Kernel only consumes the allowlisted rows (never re-stems the utterance).
      const services = result.services ?? [];
      const query =
        pending?.effect.kind === "list_services" ? pending.effect.query : undefined;
      if (result.outcome === "error" || result.outcome === "empty" || services.length === 0) {
        if (ctx.working?.deferredTurn != null) {
          emit({ type: "deferred_turn_cleared", reason: "incompatible" });
        }
        // Keep the open wait on the draft; need_service lives in facts/reason only.
        const captured = askDecisionFromPendingView(ctx.working);
        if (captured != null) {
          return {
            ...captured,
            reason: "need_service",
            facts: { ...captured.facts, clarificationReason: "need_service" },
          };
        }
        emitDecision({ kind: "clarification", reason: "need_service" });
        return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
      }
      if (services.length === 1) {
        // Selection is accepted:false — deferred schedule stays until confirm.
        return selectCatalogRow(services[0]!);
      }
      const chips = (result.choices != null && result.choices.length > 0)
        ? result.choices
        : chipsFromCatalogRows(services);
      return openCatalogPage(services, chips, query);
    }

    if (result.kind === "mutation") {
      if (result.outcome === "unknown") {
        emit({ type: "effect_cleared" });
        emit({ type: "command_cleared" });
        if (ctx.working?.selectedSlot != null) {
          emit({ type: "slot_provenance_set", provenance: "unverified_legacy", evidence: null });
        }
        emitDecision({ kind: "clarification", reason: "mutation_outcome_unknown" });
        return runEffect("run_effect", { kind: "get_working_time" });
      }
      // Chat aside / typed affirm while HITL was open.
      if (result.outcome === "pending") {
        const open = ctx.working?.pendingEffect;
        if (
          open != null
          && (
            open.effect.kind === "create_meeting"
            || open.effect.kind === "reschedule_meeting"
            || open.effect.kind === "cancel_meeting"
          )
        ) {
          const reply = result.userReply?.trim() ?? "";
          if (reply.length > 0 && isConfirmationDecline(reply)) {
            return applyControl("menu");
          }
          if (
            reply.length > 0
            && isConfirmationAffirmation(reply, result.action)
          ) {
            // Clear so preparePendingEffect mints a fresh call with confirmationGiven.
            emit({ type: "effect_cleared" });
            const effect = open.effect;
            if (effect.kind === "cancel_meeting") {
              return emitMutationConfirm(
                {
                  kind: "cancel_meeting",
                  payload: { ...effect.payload, confirmationGiven: true },
                },
                "cancel",
              );
            }
            if (effect.kind === "create_meeting") {
              return emitMutationConfirm(
                {
                  kind: "create_meeting",
                  payload: { ...effect.payload, confirmationGiven: true },
                },
                "create",
              );
            }
            return emitMutationConfirm(
              {
                kind: "reschedule_meeting",
                payload: { ...effect.payload, confirmationGiven: true },
              },
              "reschedule",
            );
          }
          // Re-arm the same HITL card (FAQ aside / non-affirm chat).
          return emitMutationConfirm(open.effect, result.action);
        }
        emit({ type: "effect_cleared" });
        emit({ type: "command_cleared" });
        return {
          tag: "reply",
          intent: "mutation_failed",
          facts: { action: result.action, failureCode: "pending" },
          card: null,
        };
      }
      if (result.outcome === "committed") {
        const w = ctx.working;
        // REPLACE cancel: continue into create (catalog or accepted service), do not
        // close with terminal «Запис скасовано.»
        if (
          result.action === "cancel"
          && w?.replacement?.status === "cancelling"
        ) {
          replaceGateExcludeIds.add(w.replacement.meeting.id);
          emit({ type: "effect_cleared" });
          emit({ type: "decision_cleared" });
          emit({ type: "cancel_existing_completed" });
          if (ctx.working?.serviceAcceptance?.status === "accepted") {
            return decideFromRequirement();
          }
          // No accepted service — kernel opens catalog (no FAQ ownership handoff).
          return runEffect("run_effect", { kind: "list_services" });
        }
        const facts: BookingVerifiedFacts = { action: result.action };
        if (w != null && result.action !== "cancel") {
          const sid = w.serviceAcceptance?.service.id;
          const sname = w.serviceAcceptance?.service.name;
          if (sid != null) facts.serviceId = sid;
          if (sname != null) facts.serviceName = sname;
          if (w.selectedSlot != null) {
            facts.dateStart = w.selectedSlot.dateStart;
            facts.date = localDate(w.selectedSlot.dateStart);
            facts.time = localTime(w.selectedSlot.dateStart);
          }
        }
        emit({ type: "draft_abandoned" });
        return { tag: "terminal", intent: "success", facts, card: null, reason: "success" };
      }
      if (result.outcome === "declined") {
        // HITL leave and ❌ both close to main menu (no get_working_time recovery).
        return applyControl("menu");
      }
      emit({ type: "effect_cleared" });
      emit({ type: "command_cleared" });
      return {
        tag: "reply",
        intent: "mutation_failed",
        facts: { action: result.action, failureCode: result.outcome },
        card: null,
      };
    }

    if (result.kind === "availability") {
      emit({ type: "effect_cleared" });
      if (result.outcome === "error") {
        // Fail closed: do not decideFromRequirement (that would remint
        // present_availability in the same consume hop). Slot revalidation may
        // have invalidated DATE/TIME — never re-offer those waits.
        if (ctx.working?.selectedSlot != null) {
          emit({ type: "slot_provenance_set", provenance: "unverified_legacy", evidence: null });
        }
        const captured = askDecisionFromPendingView(ctx.working);
        const stillValid =
          captured != null
          && captured.card?.kind !== "date_select"
          && captured.card?.kind !== "time_select"
            ? captured
            : null;
        if (stillValid != null) {
          // Keep the open wait; do not overwrite pendingDecision with clarification.
          return {
            ...stillValid,
            reason: "availability_failed",
            facts: {
              ...stillValid.facts,
              clarificationReason: "availability_failed",
            },
          };
        }
        emitDecision({ kind: "clarification", reason: "availability_failed" });
        return ask(
          "clarification",
          { kind: "clarification", reason: "availability_failed" },
          "availability_failed",
          { clarificationReason: "availability_failed" },
        );
      }
      if (result.outcome === "stale") {
        if (ctx.working?.selectedSlot != null) {
          emit({ type: "slot_provenance_set", provenance: "unverified_legacy", evidence: null });
        }
        return decideFromRequirement();
      }
      if (result.outcome === "empty" || result.outcome === "closed") {
        const snapshotId =
          result.snapshotId
          ?? readModels.availabilitySnapshotId
          ?? "availability";
        const direction =
          pending?.effect.kind === "present_availability"
            ? pending.effect.queryKind
            : "other";
        const emptyMode =
          direction === "earlier"
            ? "earlier" as const
            : direction === "exact"
              ? "exact" as const
              : "other" as const;
        const anchor =
          ctx.working?.selectedDate
          ?? readModels.availabilityDays?.[0]?.date;
        const canSearchEarlier =
          direction !== "earlier"
          && anchor != null
          && anchor > readModels.clinicDay;
        const projected = projectEmptyAvailabilityPresentation(snapshotId, {
          direction,
          canSearchEarlier,
        });
        const choiceIds = projected.choices.map((choice) => choice.id);
        const labels = labelsFromPresentation(projected);
        emitDecision({
          kind: "date_select",
          snapshotId,
          choiceIds,
          labels,
          emptyMode,
        });
        return ask("present_dates", {
          kind: "date_select",
          snapshotId,
          choiceIds,
          labels,
          emptyMode,
        });
      }
      // Revalidation of a selected slot re-stamps availability provenance.
      if (
        pending?.effect.kind === "present_availability"
        && pending.effect.revalidate === true
        && ctx.working?.selectedSlot != null
      ) {
        const evidence = slotEvidenceForSelection(
          ctx.working,
          ctx.working.selectedSlot,
          result.snapshotId,
        );
        emit({ type: "slot_provenance_set", provenance: "availability_tool", evidence });
        return decideFromRequirement();
      }

      // Fresh snapshot → date/time choice card (do not re-emit present_availability).
      const snapshotId =
        result.snapshotId
        ?? readModels.availabilitySnapshotId
        ?? "availability";
      const projected = readModels.availabilityDays != null
        ? projectAvailabilityPresentation(readModels.availabilityDays, {
          ...(ctx.working?.selectedDate != null
            ? { selectedDate: ctx.working.selectedDate }
            : {}),
          snapshotId,
        })
        : null;
      const mode = projected?.mode
        ?? result.presentationMode
        ?? "date_select";
      const choices = projected?.choices
        ?? result.presentationChoices
        ?? [];
      const choiceIds = choices.map((c) => c.id);
      const labels = projected != null
        ? labelsFromPresentation(projected)
        : Object.fromEntries(choices.map((c) => [c.id, c.label]));
      const presentationDate = projected?.date ?? result.presentationDate;
      if (mode === "time_select" && presentationDate != null) {
        emitDecision({
          kind: "time_select",
          date: presentationDate,
          snapshotId,
          choiceIds,
          labels,
        });
        return ask("present_times", {
          kind: "time_select",
          date: presentationDate,
          snapshotId,
          choiceIds,
          labels,
        });
      }
      emitDecision({
        kind: "date_select",
        snapshotId,
        choiceIds,
        labels,
      });
      return ask("present_dates", {
        kind: "date_select",
        snapshotId,
        choiceIds,
        labels,
      });
    }

    if (result.kind === "contact_lookup") {
      emit({ type: "effect_cleared" });
      if (result.outcome === "error") {
        // Fail closed: do not decideFromRequirement (that would re-mint the lookup).
        emitDecision({ kind: "clarification", reason: "contact_lookup_failed" });
        return ask(
          "ask_phone",
          { kind: "contact_field", field: "phoneNumber" },
          "contact_lookup_failed",
          { clarificationReason: "contact_lookup_failed" },
        );
      }
      const phone =
        (typeof result.phoneNumber === "string" && result.phoneNumber.trim().length > 0
          ? result.phoneNumber.trim()
          : null)
        ?? ctx.working?.contactDetails?.phoneNumber
        ?? "";
      emit({
        type: "phone_lookup_recorded",
        evidence: {
          phoneNumber: phone,
          result: result.outcome,
          contactIds: result.contactIds ?? [],
        },
      });
      return decideFromRequirement();
    }

    if (result.kind === "contact_write") {
      emit({ type: "effect_cleared" });
      if (
        (result.outcome === "created"
          || result.outcome === "updated"
          || result.outcome === "linked")
        && result.contactId != null
      ) {
        emit({
          type: "contact_resolved",
          contactId: result.contactId,
          ...(result.crmComplete === true ? { clearDetails: true } : {}),
        });
        return decideFromRequirement();
      }
      emitDecision({ kind: "clarification", reason: "contact_write_failed" });
      return ask(
        "clarification",
        { kind: "clarification", reason: "contact_write_failed" },
        "contact_write_failed",
      );
    }

    return decideFromRequirement();
  };

  /**
   * Open cancel HITL from a supervisor-seeded pendingCommand or a single
   * planned meeting. null when 0 or 2+ meetings (picker is supervisor-owned).
   */
  const openVisitCancelConfirm = (): BookingDecision | null => {
    if (ctx.working?.pendingCommand?.action === "cancel") {
      return emitMutationConfirm(
        { kind: "cancel_meeting", payload: { ...ctx.working.pendingCommand.payload } },
        "cancel",
      );
    }
    const meetings = readModels.plannedMeetings ?? [];
    if (meetings.length !== 1) {
      return null;
    }
    const meeting = firstPlannedMeeting();
    if (meeting == null) {
      return null;
    }
    const command = cancelCommandFromMeeting(meeting);
    emit({ type: "command_prepared", command });
    return emitMutationConfirm(
      { kind: "cancel_meeting", payload: { ...command.payload } },
      "cancel",
    );
  };

  const applySemanticPatch = (patch: UnderstoodBookingTurn): BookingDecision => {
    if (patch.contactFormatError != null) {
      const field = patch.contactFormatError;
      const clarificationReason =
        field === "phoneNumber"
          ? "invalid_phone"
          : field === "firstName"
            ? "invalid_firstName"
            : "invalid_lastName";
      emitDecision({ kind: "clarification", reason: clarificationReason });
      return ask(
        CONTACT_INTENT[field],
        { kind: "contact_field", field },
        clarificationReason,
        { clarificationReason },
      );
    }
    if (patch.controlIntent != null) {
      switch (patch.controlIntent.kind) {
        case "main_menu":
          return applyControl("menu");
        case "abandon": {
          // Same-turn cancel seed: cancel prose must not wipe pendingCommand
          // before the confirm card is open (interpreter often emits abandon).
          if (
            ctx.working?.pendingCommand?.action === "cancel"
            && ctx.working.pendingDecision?.kind !== "mutation_confirm"
          ) {
            const opened = openVisitCancelConfirm();
            if (opened != null) {
              return opened;
            }
          }
          return applyControl("abandon");
        }
        case "human_handoff":
          return applyControl("handoff");
        case "hitl_yes": {
          if (ctx.working?.pendingDecision?.kind !== "mutation_confirm") {
            emitDecision({ kind: "clarification", reason: "no_pending_hitl" });
            return ask(
              "clarification",
              { kind: "clarification", reason: "no_pending_hitl" },
              "no_pending_hitl",
            );
          }
          return decideFromRequirement();
        }
        case "hitl_no":
          if (ctx.working?.replacement?.status === "offered") {
            emit({ type: "cancel_existing_declined" });
            return {
              tag: "terminal",
              intent: "abandon",
              facts: {},
              card: null,
              reason: "abandon",
            };
          }
          emit({ type: "draft_abandoned" });
          return { tag: "terminal", intent: "abandon", facts: {}, card: null, reason: "abandon" };
        case "visit_status":
          return {
            tag: "reply",
            intent: "clarification",
            facts: { clarificationReason: "visit_status" },
            card: { kind: "clarification", reason: "visit_status" },
          };
        case "visit_cancel": {
          const opened = openVisitCancelConfirm();
          if (opened != null) {
            return opened;
          }
          emitDecision({ kind: "clarification", reason: "visit_cancel_ambiguous" });
          return ask(
            "clarification",
            { kind: "clarification", reason: "visit_cancel_ambiguous" },
            "visit_cancel_ambiguous",
          );
        }
        case "visit_reschedule": {
          const meetings = readModels.plannedMeetings ?? [];
          if (meetings.length === 1) {
            const meeting = firstPlannedMeeting();
            if (meeting != null) {
              emit({ type: "reschedule_started", meeting });
              return decideFromRequirement();
            }
          }
          if (meetings.length === 0) {
            emitDecision({ kind: "clarification", reason: "no_visit_to_reschedule" });
            return ask(
              "clarification",
              { kind: "clarification", reason: "no_visit_to_reschedule" },
              "no_visit_to_reschedule",
            );
          }
          emitDecision({ kind: "clarification", reason: "visit_reschedule_ambiguous" });
          return ask(
            "clarification",
            { kind: "clarification", reason: "visit_reschedule_ambiguous" },
            "visit_reschedule_ambiguous",
          );
        }
        case "greeting":
        case "help":
          // Do not abandon; resume the derived next requirement.
          return decideFromRequirement();
        case "return_to_booking":
          if (ctx.working?.pendingDecision != null) {
            emit({ type: "decision_cleared" });
          }
          return decideFromRequirement();
        default:
          break;
      }
    }

    // Explicit book with no session yet: open the attempt before deferring facts.
    if (ctx.working == null && isExplicitBookingStart(patch)) {
      emit({
        type: "booking_started",
        bookingAttemptId: newBookingAttemptId(0, readModels.clinicDay),
      });
    } else if (
      ctx.working != null
      && (ctx.working.bookingAttemptId == null || ctx.working.bookingAttemptId.length === 0)
      && isExplicitBookingStart(patch)
    ) {
      emit({
        type: "booking_started",
        bookingAttemptId: newBookingAttemptId(ctx.working.version, readModels.clinicDay),
      });
    }

    const storeDeferredFromPatch = (boundEffectId: string | null): void => {
      const schedule = deferredScheduleFromPatch(patch);
      const informational = deferredInformationalFromPatch(patch);
      if (schedule == null && informational == null) {
        return;
      }
      const attemptId =
        ctx.working?.bookingAttemptId
        ?? ctx.working?.deferredTurn?.bookingAttemptId
        ?? newBookingAttemptId(ctx.working?.version ?? 0, readModels.clinicDay);
      const deferred: DeferredBookingTurn = {
        bookingAttemptId: attemptId,
        boundEffectId,
        ...(schedule != null ? { schedule } : {}),
        ...(informational != null ? { informational } : {}),
      };
      // Merge with existing deferred schedule when only informational is new.
      const existing = ctx.working?.deferredTurn;
      if (existing != null && existing.bookingAttemptId === attemptId) {
        const mergedSchedule = schedule ?? existing.schedule;
        const mergedInfo = informational ?? existing.informational;
        const merged: DeferredBookingTurn = {
          bookingAttemptId: attemptId,
          boundEffectId,
          ...(mergedSchedule != null ? { schedule: mergedSchedule } : {}),
          ...(mergedInfo != null ? { informational: mergedInfo } : {}),
        };
        emit({ type: "deferred_turn_set", deferred: merged });
        return;
      }
      emit({ type: "deferred_turn_set", deferred });
    };

    /** Apply note/contact before any service-path early return (compound turns). */
    const emitNoteAndContactFromPatch = (): void => {
      if (patch.note?.kind === "skip") {
        emit({ type: "note_status", status: "skipped" });
      } else if (patch.note?.kind === "answer") {
        emit({ type: "note_status", status: "answered", value: patch.note.value });
      }

      if (patch.contactFacts != null) {
        const cf = patch.contactFacts;
        if (cf.phoneNumber != null) {
          emit({ type: "contact_field_submitted", field: "phoneNumber", value: cf.phoneNumber });
        }
        if (cf.firstName != null) {
          emit({ type: "contact_field_submitted", field: "firstName", value: cf.firstName });
        }
        if (cf.lastName != null) {
          emit({ type: "contact_field_submitted", field: "lastName", value: cf.lastName });
        }
      }
    };

    /** Note/contact + deferred schedule/price after resetting the service ladder. */
    const applyCompoundFactsAfterServiceSwitch = (): void => {
      emitNoteAndContactFromPatch();
      storeDeferredFromPatch(null);
    };

    // REPLACE chip: cancel current visit, then HITL.
    if (
      patch.choice?.choiceId === "cancel_existing"
      && ctx.working?.replacement?.status === "offered"
    ) {
      const meeting = ctx.working.replacement.meeting;
      const command = cancelCommandFromMeeting(meeting);
      emit({ type: "cancel_existing_requested", command });
      return emitMutationConfirm(
        { kind: "cancel_meeting", payload: { ...command.payload } },
        "cancel",
      );
    }

    const service = patch.serviceIntent;
    // Catalog chip switch: select first so clearDownstream drops the old ladder,
    // then apply this-turn note/contact/deferred onto the new service.
    if (service?.kind === "catalog_service") {
      emit({
        type: "service_selected",
        service: {
          id: service.serviceId,
          ...(service.serviceName != null ? { name: service.serviceName } : {}),
          source: "catalog",
          ...(service.durationMinutes != null ? { durationMinutes: service.durationMinutes } : {}),
        },
        accepted: false,
      });
      applyCompoundFactsAfterServiceSwitch();
      return decideFromRequirement();
    }

    // Named-procedure switch: invalidate old service before this-turn facts so
    // unique catalog selection is a first selection (keeps new note/deferred).
    if (
      service?.kind === "named_procedure"
      && ctx.working?.serviceAcceptance != null
    ) {
      emit({ type: "service_invalidated" });
    }

    // Compound facts must land before list_services / other early returns.
    emitNoteAndContactFromPatch();

    if (service?.kind === "confirm_pending_service") {
      if (ctx.working?.serviceAcceptance?.status === "pending") {
        emit({ type: "service_accepted" });
      }
      // After acceptance, apply deferred schedule (requestedTime pending) and price.
      const deferred = ctx.working?.deferredTurn;
      if (
        ctx.working?.serviceAcceptance?.status === "accepted"
        && deferred?.schedule != null
      ) {
        const sched = deferred.schedule;
        if (sched.date != null) {
          emit({
            type: "schedule_requested",
            date: sched.date,
            ...(sched.preferredTime != null ? { preferredTime: sched.preferredTime } : {}),
          });
        }
      }
      if (
        deferred?.informational?.topic === "price"
        && ctx.working?.serviceAcceptance?.service.id != null
      ) {
        const serviceId = ctx.working.serviceAcceptance.service.id;
        emit({ type: "deferred_informational_consumed" });
        const pending = preparePendingEffect({ kind: "get_service", serviceId });
        if (ctx.working?.deferredTurn?.schedule != null) {
          emit({ type: "deferred_turn_bound", boundEffectId: pending.id });
        } else if (ctx.working?.deferredTurn != null) {
          emit({ type: "deferred_turn_cleared", reason: "consumed" });
        }
        return {
          tag: "effect",
          intent: "answer_side_question",
          facts: {},
          card: null,
          pendingEffect: pending,
        };
      }
      if (
        deferred?.schedule != null
        && ctx.working?.serviceAcceptance?.status === "accepted"
      ) {
        const sched = deferred.schedule;
        emit({ type: "deferred_turn_cleared", reason: "consumed" });
        const queryKind = sched.relative ?? "exact";
        return runEffect(
          "present_dates",
          presentAvailabilityEffect(ctx.working, {
            queryKind: queryKind === "exact" ? "exact" : queryKind,
            ...(sched.date != null ? { date: sched.date } : {}),
            ...(sched.preferredTime != null ? { preferredTime: sched.preferredTime } : {}),
          }),
        );
      }
    } else if (service?.kind === "named_procedure") {
      // Book-with-visit: REPLACE before catalog resolve — not while already
      // browsing a choose-other / catalog page (narrow the open picker instead).
      const browsingCatalog =
        ctx.working?.pendingDecision?.kind === "service_candidate";
      if (!browsingCatalog && ctx.working?.replacement == null) {
        const existing = firstPlannedMeeting();
        if (existing != null) {
          return askReplacementOffer(existing);
        }
      }
      // Never trust a model CRM id — resolve via list_services catalog evidence.
      // Defer schedule/price before the effect so they survive catalog + confirm.
      storeDeferredFromPatch(null);
      const pending = preparePendingEffect({
        kind: "list_services",
        query: service.query,
      });
      emit({ type: "deferred_turn_bound", boundEffectId: pending.id });
      return {
        tag: "effect",
        intent: "run_effect",
        facts: {},
        card: null,
        pendingEffect: pending,
      };
    } else if (service?.kind === "catalog_browse") {
      // Idle browse without booking_started is routed away from the kernel.
      // In-session browse may still list services; keep deferred schedule.
      storeDeferredFromPatch(null);
      const pending = preparePendingEffect({
        kind: "list_services",
        ...(service.query != null ? { query: service.query } : {}),
      });
      if (ctx.working?.deferredTurn != null) {
        emit({ type: "deferred_turn_bound", boundEffectId: pending.id });
      }
      return {
        tag: "effect",
        intent: "run_effect",
        facts: {},
        card: null,
        pendingEffect: pending,
      };
    } else if (service?.kind === "consultation") {
      // Book-with-visit: REPLACE before consultation offer.
      if (ctx.working?.replacement == null) {
        const existing = firstPlannedMeeting();
        if (existing != null) {
          return askReplacementOffer(existing);
        }
      }
      emit({
        type: "service_selected",
        service: {
          id: CONSULTATION_SERVICE_ID,
          name: CONSULTATION_SERVICE_NAME_UK,
          source: "catalog",
        },
        accepted: false,
      });
    } else if (service?.kind === "book_highlighted") {
      // Supervisor must rewrite to catalog_service; this branch is fail-closed only.
      // Never select consultation from a leaked book_highlighted.
      emitDecision({ kind: "clarification", reason: "need_service" });
      return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
    } else if (service?.kind === "decline_pending_service") {
      // Same as catalog_browse: wipe the pending offer, then list services.
      // Do not emit need_service clarification (projects to a null keyboard).
      emit({ type: "draft_abandoned" });
      return runEffect("run_effect", {
        kind: "list_services",
      });
    }

    const schedule = patch.scheduleIntent;
    if (schedule?.kind === "relative" || (schedule?.kind === "choice"
      && (schedule.choiceId === "other_date"
        || schedule.choiceId === "earlier"
        || schedule.choiceId === "later")))
    {
      if (ctx.working?.pendingDecision?.kind === "date_select"
        || ctx.working?.pendingDecision?.kind === "time_select")
      {
        emit({ type: "decision_cleared" });
      }
      const queryKind = queryKindFromSchedule(schedule);
      const date = dateFromSchedule(schedule, ctx.working);
      return runEffect(
        "present_dates",
        presentAvailabilityEffect(ctx.working, {
          queryKind,
          ...(date != null ? { date } : {}),
        }),
      );
    }
    if (schedule?.kind === "date") {
      if (ctx.working?.pendingDecision?.kind === "date_select"
        || ctx.working?.pendingDecision?.kind === "time_select")
      {
        emit({ type: "decision_cleared" });
      }
      emit({ type: "schedule_requested", date: schedule.date });
      // Prefer presenting times from the current snapshot when the day is open.
      const day = readModels.availabilityDays?.find((d) => d.date === schedule.date);
      if (day != null && day.slots.length > 0) {
        const snapshotId = readModels.availabilitySnapshotId ?? "availability";
        const projected = projectAvailabilityPresentation(
          readModels.availabilityDays ?? [day],
          { selectedDate: schedule.date, snapshotId },
        );
        if (projected?.mode === "time_select" && projected.date != null) {
          const choiceIds = projected.choices.map((c) => c.id);
          const labels = labelsFromPresentation(projected);
          emitDecision({
            kind: "time_select",
            date: projected.date,
            snapshotId,
            choiceIds,
            labels,
          });
          return ask("present_times", {
            kind: "time_select",
            date: projected.date,
            snapshotId,
            choiceIds,
            labels,
          });
        }
      }
    } else if (schedule?.kind === "date_and_time") {
      if (ctx.working?.pendingDecision != null) {
        emit({ type: "decision_cleared" });
      }
      emit({ type: "schedule_requested", date: schedule.date, preferredTime: schedule.time });
    } else if (schedule?.kind === "time") {
      const date = ctx.working?.selectedDate;
      if (date != null) {
        if (ctx.working?.pendingDecision?.kind === "time_select") {
          emit({ type: "decision_cleared" });
        }
        emit({ type: "schedule_requested", date, preferredTime: schedule.time });
      }
    } else if (schedule?.kind === "slot") {
      if (ctx.working?.pendingDecision?.kind === "time_select"
        || ctx.working?.pendingDecision?.kind === "date_select")
      {
        emit({ type: "decision_cleared" });
      }
      const slotDate = schedule.slot.dateStart.slice(0, 10);
      if (ctx.working?.selectedDate !== slotDate) {
        emit({ type: "date_selected", date: slotDate });
      }
      emit({
        type: "slot_selected",
        slot: {
          dateStart: schedule.slot.dateStart,
          dateEnd: schedule.slot.dateEnd,
          label: schedule.slot.label,
        },
        ...(schedule.snapshotId != null ? { snapshotId: schedule.snapshotId } : {}),
      });
    } else if (schedule?.kind === "choice") {
      // Unresolved choice id (not other_date/earlier/later) — ask clarification.
      emitDecision({ kind: "clarification", reason: "unknown_choice" });
      return ask(
        "clarification",
        { kind: "clarification", reason: "unknown_choice" },
        "unknown_choice",
      );
    }

    // Note/contact already applied via emitNoteAndContactFromPatch above.

    // Side question may coexist with booking facts — apply facts first, then read effect.
    // Never map unrecognized questions to get_working_time.
    if (patch.informationalQuestion != null) {
      const topic = patch.faqTopic
        ?? deferredInformationalFromPatch(patch)?.topic
        ?? "other";
      if (topic === "hours") {
        return runEffect("answer_side_question", { kind: "get_working_time" });
      }
      if (topic === "address") {
        const nextReq = nextBookingRequirement(ctx.working, readModels);
        return sideQuestionReply(
          {
            address: CLINIC_ADDRESS,
            ...(nextReq !== "none" ? { nextStep: nextReq } : {}),
          },
          ctx.working,
        );
      }
      if (topic === "price") {
        const serviceId = ctx.working?.serviceAcceptance?.service.id;
        if (serviceId != null) {
          return runEffect("answer_side_question", { kind: "get_service", serviceId });
        }
        // Defer price until a verified service is on the draft.
        storeDeferredFromPatch(null);
        return decideFromRequirement();
      }
      // Parking / policy / unknown: honest unknown, preserve session + open card.
      const nextReq = nextBookingRequirement(ctx.working, readModels);
      return sideQuestionReply(
        {
          clarificationReason: "unknown_faq",
          ...(nextReq !== "none" ? { nextStep: nextReq } : {}),
        },
        ctx.working,
      );
    }

    // Apply deferred schedule when acceptance happened earlier in this patch path
    // without an informational diversion.
    if (
      patch.scheduleIntent != null
      && ctx.working?.serviceAcceptance?.status === "accepted"
    ) {
      // schedule applied above in the normal schedule block when legal.
    } else if (
      patch.scheduleIntent != null
      && ctx.working?.serviceAcceptance?.status !== "accepted"
    ) {
      storeDeferredFromPatch(ctx.working?.pendingEffect?.id ?? null);
    }

    return decideFromRequirement();
  };

  let decision: BookingDecision;
  switch (input.source) {
    case "control":
      decision = applyControl(input.intent);
      break;
    case "effect_result":
      decision = applyEffectResult(input.result);
      break;
    case "catalog_page":
      decision = applyCatalogPage(input.remainingIds, input.choices);
      break;
    case "semantic_patch":
      decision = applySemanticPatch(input.patch);
      break;
    case "patient_turn":
      decision =
        input.rawText.trim().length === 0
          ? decideFromRequirement()
          : {
              tag: "ask",
              intent: "need_interpreter",
              facts: {},
              card: { kind: "clarification", reason: "needs_interpreter" },
              reason: "needs_interpreter",
            };
      break;
    default: {
      const _exhaustive: never = input;
      decision = _exhaustive;
    }
  }

  return { events, decision };
};

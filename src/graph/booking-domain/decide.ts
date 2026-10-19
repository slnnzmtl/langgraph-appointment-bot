import {
  BOOKING_OFFER_MENU,
  CLINIC_ADDRESS,
  CONSULTATION_SERVICE_ID,
  OTHER_DATE_LABEL,
} from "../../shared/clinic-constants.js";
import {
  nextMissingContactField,
  reduceBookingDraft,
  slotEvidenceForSelection,
  type BookingContactDetails,
  type BookingDraft,
  type BookingEvent,
} from "../booking-draft.js";
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
  labelsFromPresentation,
  projectAvailabilityPresentation,
} from "./availability-presentation.js";
import type { BookingEffect, EffectResult, PendingEffect } from "./effects.js";
import { nextBookingRequirement } from "./requirement.js";
import type { PendingDecision } from "./session.js";
import type { UnderstoodBookingTurn } from "./turn.js";

const CONTACT_INTENT: Record<"phoneNumber" | "firstName" | "lastName", BookingSemanticIntent> = {
  phoneNumber: "ask_phone",
  firstName: "ask_first_name",
  lastName: "ask_last_name",
};

/** Deep structural equality for emit-once effect correlation. */
const sameEffect = (a: BookingEffect, b: BookingEffect): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const localDate = (iso: string): string => iso.slice(0, 10);
const localTime = (iso: string): string => iso.slice(11, 16);

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
    // Exact-slot revalidate before freezing a create/reschedule write.
    if (
      (action === "create" || action === "reschedule")
      && w.selectedSlot != null
      && (w.slotProvenance !== "availability_tool" || w.slotEvidence?.snapshotId == null)
    ) {
      return runEffect("run_effect", {
        kind: "present_availability",
        queryKind: "exact",
        date: w.selectedDate ?? localDate(w.selectedSlot.dateStart),
        preferredTime: localTime(w.selectedSlot.dateStart),
        revalidate: true,
      });
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
    emitDecision({ kind: "mutation_confirm", action, effectId: pending.id });
    const w2 = ctx.working ?? w;
    return mutationConfirmDecision(w2, action, pending.id, pending);
  };

  /** Contact identity ladder after phone is known and contactId is missing. */
  const decideContactDetails = (): BookingDecision => {
    const w = ctx.working;
    if (w == null) {
      return { tag: "reply", intent: "idle", facts: {}, card: null };
    }
    const details: BookingContactDetails = w.contactDetails ?? {};
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

    // Pending service confirmation.
    if (w.serviceAcceptance?.status === "pending") {
      emitDecision({ kind: "clarification", reason: "confirm_service" });
      const service = w.serviceAcceptance.service;
      const facts: BookingVerifiedFacts = { serviceId: service.id };
      if (service.name != null) facts.serviceName = service.name;
      return {
        tag: "ask",
        intent: "confirm_service",
        facts,
        card: {
          kind: "service_confirm",
          serviceId: service.id,
          choiceIds: ["offer_accept", "offer_choose_other"],
          labels: {
            offer_accept: BOOKING_OFFER_MENU[0],
            offer_choose_other: BOOKING_OFFER_MENU[1],
          },
        },
      };
    }

    // Fresh availability snapshot awaiting a date/time choice — do not re-fetch.
    if (w.pendingDecision?.kind === "date_select") {
      const pending = w.pendingDecision;
      return ask("present_dates", {
        kind: "date_select",
        snapshotId: pending.snapshotId,
        choiceIds: [...pending.choiceIds],
        labels: { ...pending.labels },
      });
    }
    if (w.pendingDecision?.kind === "time_select") {
      const pending = w.pendingDecision;
      return ask("present_times", {
        kind: "time_select",
        date: pending.date,
        snapshotId: pending.snapshotId,
        choiceIds: [...pending.choiceIds],
        labels: { ...pending.labels },
      });
    }

    // Replacement offered → cancel existing before create.
    if (w.replacement?.status === "offered") {
      return emitMutationConfirm(
        { kind: "cancel_meeting", payload: { meetingId: w.replacement.meeting.id } },
        "cancel",
      );
    }

    const requirement = nextBookingRequirement(w, readModels);
    switch (requirement) {
      case "service":
        emitDecision({ kind: "clarification", reason: "need_service" });
        return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
      case "date":
      case "time":
        return runEffect(requirement === "date" ? "present_dates" : "present_times", {
          kind: "present_availability",
          queryKind: w.selectedDate != null ? "exact" : "nearest",
          ...(w.selectedDate != null ? { date: w.selectedDate } : {}),
          ...(w.requestedTime != null ? { preferredTime: w.requestedTime.value } : {}),
        });
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
        if (w.mode === "reschedule" && w.rescheduleTarget != null && w.selectedSlot != null) {
          return emitMutationConfirm(
            {
              kind: "reschedule_meeting",
              payload: {
                meetingId: w.rescheduleTarget.id,
                dateStart: w.selectedSlot.dateStart,
                dateEnd: w.selectedSlot.dateEnd,
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
      const nextReq = nextBookingRequirement(ctx.working, readModels);
      if (nextReq !== "none") facts.nextStep = nextReq;
      return { tag: "reply", intent: "answer_side_question", facts, card: null };
    }

    if (result.kind === "catalog") {
      emit({ type: "effect_cleared" });
      const services = result.services ?? [];
      if (result.outcome === "error" || result.outcome === "empty" || services.length === 0) {
        emitDecision({ kind: "clarification", reason: "need_service" });
        return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
      }
      if (services.length === 1) {
        const only = services[0]!;
        emit({
          type: "service_selected",
          service: { id: only.id, name: only.name, source: "catalog" },
          accepted: false,
        });
        return decideFromRequirement();
      }
      const choiceIds = services.slice(0, 5).map((s) => s.id);
      const labels: Record<string, string> = {};
      for (const service of services.slice(0, 5)) {
        labels[service.id] = service.name;
      }
      emitDecision({
        kind: "service_candidate",
        ...(pending?.effect.kind === "list_services" && pending.effect.query != null
          ? { utterance: pending.effect.query, query: pending.effect.query }
          : {}),
        choiceIds,
        labels,
      });
      return ask("ask_service", {
        kind: "service_candidate",
        choiceIds,
        labels,
      }, "service_candidates");
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
      if (result.outcome === "committed") {
        const w = ctx.working;
        const facts: BookingVerifiedFacts = { action: result.action };
        if (w != null && result.action !== "cancel") {
          const sid = w.serviceAcceptance?.service.id;
          const sname = w.serviceAcceptance?.service.name;
          if (sid != null) facts.serviceId = sid;
          if (sname != null) facts.serviceName = sname;
          if (w.selectedSlot != null) {
            facts.date = localDate(w.selectedSlot.dateStart);
            facts.time = localTime(w.selectedSlot.dateStart);
          }
        }
        emit({ type: "draft_abandoned" });
        return { tag: "terminal", intent: "success", facts, card: null, reason: "success" };
      }
      if (result.outcome === "declined") {
        emit({ type: "draft_abandoned" });
        return { tag: "terminal", intent: "abandon", facts: {}, card: null, reason: "abandon" };
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
      if (result.outcome === "stale" || result.outcome === "error") {
        if (ctx.working?.selectedSlot != null) {
          emit({ type: "slot_provenance_set", provenance: "unverified_legacy", evidence: null });
        }
        return decideFromRequirement();
      }
      if (result.outcome === "empty" || result.outcome === "closed") {
        emitDecision({ kind: "clarification", reason: "availability_empty" });
        return ask(
          "clarification",
          { kind: "clarification", reason: "availability_empty" },
          "availability_empty",
        );
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
        emit({ type: "contact_resolved", contactId: result.contactId });
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

  const applySemanticPatch = (patch: UnderstoodBookingTurn): BookingDecision => {
    if (patch.controlIntent != null) {
      switch (patch.controlIntent.kind) {
        case "main_menu":
          return applyControl("menu");
        case "abandon":
          return applyControl("abandon");
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
          emit({ type: "draft_abandoned" });
          return { tag: "terminal", intent: "abandon", facts: {}, card: null, reason: "abandon" };
        case "visit_status":
          return {
            tag: "reply",
            intent: "clarification",
            facts: { clarificationReason: "visit_status" },
            card: { kind: "clarification", reason: "visit_status" },
          };
        case "return_to_booking":
          if (ctx.working?.pendingDecision != null) {
            emit({ type: "decision_cleared" });
          }
          return decideFromRequirement();
        default:
          break;
      }
    }

    const service = patch.serviceIntent;
    if (service?.kind === "confirm_pending_service") {
      if (ctx.working?.serviceAcceptance?.status === "pending") {
        emit({ type: "service_accepted" });
      }
    } else if (service?.kind === "catalog_service") {
      // Only catalog-resolved ids may write service_selected.
      emit({
        type: "service_selected",
        service: {
          id: service.serviceId,
          ...(service.serviceName != null ? { name: service.serviceName } : {}),
          source: "catalog",
        },
        accepted: true,
      });
    } else if (service?.kind === "named_procedure") {
      // Never trust a model CRM id — resolve via list_services catalog evidence.
      return runEffect("run_effect", {
        kind: "list_services",
        query: service.query,
      });
    } else if (service?.kind === "catalog_browse") {
      return runEffect("run_effect", {
        kind: "list_services",
        ...(service.query != null ? { query: service.query } : {}),
      });
    } else if (service?.kind === "consultation") {
      emit({
        type: "service_selected",
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        accepted: false,
      });
    } else if (service?.kind === "decline_pending_service") {
      emit({ type: "draft_abandoned" });
      emitDecision({ kind: "clarification", reason: "need_service" });
      return ask("ask_service", { kind: "clarification", reason: "need_service" }, "need_service");
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
      const queryKind =
        schedule.kind === "relative"
          ? schedule.queryKind
          : schedule.choiceId === "earlier"
            ? "earlier"
            : schedule.choiceId === "later" || schedule.choiceId === "other_date"
              ? "later"
              : "nearest";
      return runEffect("present_dates", {
        kind: "present_availability",
        queryKind,
        ...(schedule.kind === "relative" && schedule.anchor != null
          ? { date: schedule.anchor }
          : ctx.working?.selectedDate != null
            ? { date: ctx.working.selectedDate }
            : {}),
      });
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
        const choiceIds = [
          ...day.slots.slice(0, 3).map((s) => s.id),
          "other_date",
        ];
        const labels: Record<string, string> = { other_date: OTHER_DATE_LABEL };
        for (const slot of day.slots.slice(0, 3)) {
          labels[slot.id] = slot.label;
        }
        emitDecision({
          kind: "time_select",
          date: schedule.date,
          snapshotId,
          choiceIds,
          labels,
        });
        return ask("present_times", {
          kind: "time_select",
          date: schedule.date,
          snapshotId,
          choiceIds,
          labels,
        });
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

    // Side question may coexist with booking facts — apply facts first, then read effect.
    if (patch.informationalQuestion != null) {
      const kind = patch.informationalQuestion.trim().toLowerCase();
      if (kind === "hours" || kind.includes("hour") || kind.includes("годин")) {
        return runEffect("answer_side_question", { kind: "get_working_time" });
      }
      if (kind === "address" || kind.includes("address") || kind.includes("адрес")) {
        const nextReq = nextBookingRequirement(ctx.working, readModels);
        return {
          tag: "reply",
          intent: "answer_side_question",
          facts: {
            address: CLINIC_ADDRESS,
            ...(nextReq !== "none" ? { nextStep: nextReq } : {}),
          },
          card: null,
        };
      }
      if (kind === "price" || kind.includes("price") || kind.includes("цін")) {
        const serviceId = ctx.working?.serviceAcceptance?.service.id;
        if (serviceId != null) {
          return runEffect("answer_side_question", { kind: "get_service", serviceId });
        }
        // Defer price until a verified service is on the draft.
        return decideFromRequirement();
      }
      return runEffect("answer_side_question", { kind: "get_working_time" });
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

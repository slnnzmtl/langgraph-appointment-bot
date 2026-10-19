import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
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
        },
      };
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
      }
      return decideFromRequirement();
    }

    if (result.kind === "contact_lookup") {
      emit({ type: "effect_cleared" });
      if (result.outcome !== "error") {
        const phone = ctx.working?.contactDetails?.phoneNumber ?? "";
        emit({
          type: "phone_lookup_recorded",
          evidence: { phoneNumber: phone, result: result.outcome, contactIds: result.contactIds ?? [] },
        });
      }
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
    } else if (service?.kind === "named_procedure" && service.serviceId != null) {
      emit({
        type: "service_selected",
        service: { id: service.serviceId, name: service.query, source: "catalog" },
        accepted: true,
      });
    } else if (service?.kind === "consultation") {
      emit({
        type: "service_selected",
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        accepted: false,
      });
    }

    const schedule = patch.scheduleIntent;
    if (schedule?.kind === "date") {
      emit({ type: "schedule_requested", date: schedule.date });
    } else if (schedule?.kind === "date_and_time") {
      emit({ type: "schedule_requested", date: schedule.date, preferredTime: schedule.time });
    } else if (schedule?.kind === "time") {
      const date = ctx.working?.selectedDate;
      if (date != null) {
        emit({ type: "schedule_requested", date, preferredTime: schedule.time });
      }
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

    // Informational question is read-only (only key present): surface facts via effect.
    if (patch.informationalQuestion != null && Object.keys(patch).length === 1) {
      return runEffect("run_effect", { kind: "get_working_time" });
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

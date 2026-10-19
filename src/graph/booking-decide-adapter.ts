/**
 * Temporary Phase 2 adapter: maps pure BookingDecision tags onto today's
 * BookingCommandOutcome vocabulary. resolveBookingCommand remains the graph
 * entry until Phase 5 collapses orchestration onto decideBooking directly.
 */
import type { BookingCommandOutcome } from "./agent-loop/booking-command.js";
import type { BookingDecision } from "./booking-domain/decision.js";
import { decideBooking } from "./booking-domain/decide.js";
import type { BookingInput, BookingReadModels } from "./booking-domain/decision.js";
import type { PendingEffect } from "./booking-domain/effects.js";
import type { BookingSessionV2 } from "./booking-domain/session.js";
import { bookingDraftToSession, sessionToBookingDraft } from "./booking-session-convert.js";
import type { BookingDraft } from "./booking-draft.js";
import type { ClinicState } from "./state.js";

export const readModelsFromClinicState = (state: ClinicState): BookingReadModels => ({
  contactContextDirty: state.prefetchDirty === true,
  bookingContextDirty: state.prefetchDirty === true,
  availabilityVerified: state.availabilityContext != null && state.prefetchDirty !== true,
});

export const sessionFromClinicState = (state: ClinicState): BookingSessionV2 | null => {
  if (state.bookingDraft == null) {
    return null;
  }
  return bookingDraftToSession(state.bookingDraft, state.pendingInteraction);
};

/**
 * Project a pure decision into the legacy command-outcome shape used by
 * command_prepare routers. Effect execution still goes through ToolNode.
 */
export const bookingDecisionToCommandOutcome = (
  decision: BookingDecision,
): BookingCommandOutcome => {
  const draft = decision.session == null ? null : sessionToBookingDraft(decision.session);
  switch (decision.tag) {
    case "effect":
      return {
        kind: "execute",
        toolCall: {
          id: decision.pendingEffect.id,
          name: effectToToolName(decision.pendingEffect),
          args: effectToToolArgs(decision.pendingEffect),
          action: decision.pendingEffect.effect.kind,
        },
        update: { bookingDraft: draft },
      };
    case "mutation_confirm":
      return {
        kind: "execute",
        toolCall: {
          id: decision.pendingEffect.id,
          name: effectToToolName(decision.pendingEffect),
          args: effectToToolArgs(decision.pendingEffect),
          action: decision.pendingEffect.effect.kind,
        },
        update: {
          bookingDraft: draft,
          pendingInteraction: {
            kind: "mutation_confirm",
            action:
              decision.pendingEffect.effect.kind === "create_meeting"
                ? "create"
                : decision.pendingEffect.effect.kind === "reschedule_meeting"
                  ? "reschedule"
                  : "cancel",
            choices: [
              { id: "confirm", label: "✅" },
              { id: "decline", label: "❌" },
            ],
          },
        },
      };
    case "ask":
    case "reply":
      return {
        kind: "render",
        reason: decision.tag === "ask"
          && decision.view.card?.kind === "contact_field"
          ? "contact_field"
          : decision.view.card?.kind === "visit_note"
            ? "note_required"
            : "stale_slot",
        update: {
          bookingDraft: draft,
          lastHandoff: {
            agentId: "booking",
            agentName: "booking",
            status: "ok",
            replyText: decision.view.replyText,
            ...(decision.view.replyButtons != null
              ? { replyButtons: decision.view.replyButtons }
              : {}),
          },
        },
      };
    case "terminal":
      return {
        kind: "finalize",
        reason: "pending_interaction",
        update: {
          bookingDraft: draft,
          lastHandoff: {
            agentId: decision.reason === "menu" || decision.reason === "abandon"
              ? "FINISH"
              : "booking",
            agentName: "booking",
            status: "ok",
            replyText: decision.view.replyText,
          },
        },
      };
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
};

const effectToToolName = (pending: PendingEffect): string => {
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

const effectToToolArgs = (pending: PendingEffect): Record<string, unknown> => {
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

/**
 * Optional pure entry used by tests and Phase 5. Does not replace
 * resolveBookingCommand in production routers yet.
 */
export const decideBookingFromDraft = (
  draft: BookingDraft,
  input: BookingInput,
  readModels: BookingReadModels,
): BookingDecision =>
  decideBooking(bookingDraftToSession(draft), input, readModels);

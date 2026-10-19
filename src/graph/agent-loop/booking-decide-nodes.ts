/**
 * Thin LangGraph adapters for the decide/effect loop (DDD-277).
 * Compiled interrupt-capable node name `booking__tools` must remain the HITL
 * resume target through compatibility release 6A.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";

import {
  bookingDecisionToCommandOutcome,
  readModelsFromClinicState,
  sessionFromClinicState,
} from "../booking-decide-adapter.js";
import { decideBooking } from "../booking-domain/decide.js";
import type { EffectResult } from "../booking-domain/effects.js";
import {
  interpretBookingTurnDeterministic,
} from "../booking-domain/interpret.js";
import {
  projectBookingView,
  semanticChoicesFromView,
} from "../booking-domain/view.js";
import { recoverExpiredConfirmBookingHitl } from "../booking-hitl-recovery.js";
import { sessionToBookingDraft } from "../booking-session-convert.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { stampBookingEffect, assertStampedBookingToolCall } from "./stamp-booking-effect.js";
import { stampRuntimeToolAi } from "./runtime-tool-stamp.js";

export const BOOKING_DECIDE_NODE = "booking__decide" as const;
/** Keep legacy name as the ToolNode / HITL resume target. */
export const BOOKING_EFFECTS_NODE = "booking__tools" as const;

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

/**
 * Translate the latest ToolMessage into a typed EffectResult for the kernel.
 * Never lets decideBooking inspect the message tape directly.
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
      if (record?.cancelled === true) {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "declined" };
      }
      if (typeof record?.id === "string" || typeof record?.meetingId === "string") {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "committed" };
      }
      if (body.startsWith("Error:") || record?.error != null) {
        return { effectId: expectedEffectId, kind: "mutation", action, outcome: "failed" };
      }
      return { effectId: expectedEffectId, kind: "mutation", action, outcome: "unknown" };
    }

    if (
      name === "get_working_time"
      || name === "list_services"
      || name === "get_service"
    ) {
      if (body.startsWith("Error:") || record?.error != null) {
        return { effectId: expectedEffectId, kind: "informational", outcome: "error" };
      }
      return { effectId: expectedEffectId, kind: "informational", outcome: "ok" };
    }
  }
  return null;
};

/**
 * Patient turn or typed EffectResult → interpreter → decideBooking → state update.
 * Does not inspect the ToolMessage tape beyond typed effect results.
 */
export const createBookingDecideNode = () =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const session = sessionFromClinicState(state);
    if (session == null) {
      return {};
    }
    const readModels = readModelsFromClinicState(state);

    // Prefer typed effect results when a pending effect is awaiting correlation.
    const pendingEffectId = session.pendingEffect?.id
      ?? (typeof state.bookingDraft?.pendingEffect?.id === "string"
        ? state.bookingDraft.pendingEffect.id
        : null);
    const effectResult = effectResultFromToolMessages(state.agentMessages, pendingEffectId);
    if (effectResult != null) {
      const decision = decideBooking(
        session,
        { source: "effect_result", result: effectResult },
        readModels,
      );
      return applyDecisionUpdate(decision, session, readModels);
    }

    const rawText = lastHumanText(state.messages);
    const projected = projectBookingView({ session, readModels });
    const choices = semanticChoicesFromView({ card: projected.card });
    const awaitingContactField =
      session.contact.phoneNumber != null && session.contact.firstName == null
        ? "firstName" as const
        : session.contact.phoneNumber != null
          && session.contact.firstName != null
          && session.contact.lastName == null
          ? "lastName" as const
          : null;
    const patch = interpretBookingTurnDeterministic({
      rawText,
      choices,
      awaitingNote: session.note.status === "awaiting",
      ...(awaitingContactField != null ? { awaitingContactField } : {}),
      awaitingServiceConfirm: session.serviceAcceptance?.status === "pending",
    });
    const input = Object.keys(patch).length > 0
      ? { source: "semantic_patch" as const, patch }
      : { source: "patient_turn" as const, rawText };
    const decision = decideBooking(session, input, readModels);
    return applyDecisionUpdate(decision, session, readModels);
  };

const applyDecisionUpdate = (
  decision: ReturnType<typeof decideBooking>,
  session: NonNullable<ReturnType<typeof sessionFromClinicState>>,
  readModels: ReturnType<typeof readModelsFromClinicState>,
): ClinicStateUpdate => {
  const outcome = bookingDecisionToCommandOutcome(decision);
  if (outcome.kind === "execute") {
    const pending =
      decision.tag === "effect" || decision.tag === "mutation_confirm"
        ? decision.pendingEffect
        : {
            id: outcome.toolCall.id,
            expectedRevision: session.revision,
            effect: { kind: "get_working_time" as const },
            status: "prepared" as const,
          };
    const stamped = stampBookingEffect(pending);
    assertStampedBookingToolCall(stamped);
    const view = projectBookingView({
      session: decision.session ?? session,
      readModels,
    });
    const runtimeAi = stampRuntimeToolAi(
      stamped.name,
      [{
        id: stamped.id,
        name: stamped.name,
        args: stamped.args,
        type: "tool_call",
      }],
      stamped.action,
    );
    return {
      ...outcome.update,
      bookingDraft: decision.session != null
        ? sessionToBookingDraft(decision.session)
        : null,
      agentMessages: [runtimeAi],
      ...(view.replyText
        ? {
            lastHandoff: {
              agentId: "booking",
              agentName: "booking",
              status: "ok",
              replyText: view.replyText,
              ...(view.replyButtons != null ? { replyButtons: view.replyButtons } : {}),
            },
          }
        : {}),
    };
  }
  return outcome.update ?? {};
};

/** Resume adapter for legacy confirm_booking interrupts bound to booking__tools. */
export const createLegacyConfirmResumeRecovery = () =>
  (state: ClinicState): ClinicStateUpdate => {
    const recovered = recoverExpiredConfirmBookingHitl({
      bookingDraft: state.bookingDraft,
    });
    return {
      bookingDraft: recovered.bookingDraft,
      pendingInteraction: recovered.pendingInteraction,
      lastHandoff: {
        agentId: "booking",
        agentName: "booking",
        status: "ok",
        replyText: recovered.replyText,
      },
    };
  };

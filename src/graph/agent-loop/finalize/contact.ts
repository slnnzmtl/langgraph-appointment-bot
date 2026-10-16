import { AIMessage } from "@langchain/core/messages";
import {
  BOOKING_AGENT_ID,
  type ClinicAgentDefinition,
} from "../../types.js";
import { trackEvent } from "../../../analytics/track.js";
import {
  BOOKING_CONTACT_SAVE_FAILED_UK,
  BOOKING_PHONE_OCCUPIED_UK,
  PATIENT_FALLBACK_MESSAGE,
} from "../../../shared/clinic-constants.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  effectiveBookingContactDetails,
  nextMissingContactField,
} from "../../booking-draft.js";
import {
  reduceBookingSession,
  type PendingInteraction,
} from "../../booking-session.js";
import {
  replyButtonsForInteraction,
  renderBookingInteractionMessage,
} from "../../booking-interaction-render.js";
import { tagRuntimeAgentMessage } from "../../sub-agent-messages.js";
import {
  phoneCandidateHasLinkableRow,
  resolveContactIdentity,
} from "../../contact-command.js";
import {
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
  phoneLookupFailedThisTurn,
  terminalContactWriteOutcome,
} from "../protocol.js";
import type { ClearedTape } from "./shared.js";

/** True when the create draft is past service / slot / note and ready for identity. */
export const bookingDetailsReady = (state: ClinicState): boolean => {
  const draft = state.bookingDraft;
  return draft?.mode === "create"
    && draft.serviceAcceptance?.status === "accepted"
    && draft.selectedSlot != null
    && (draft.note.status === "skipped" || draft.note.status === "answered");
};

/** Effective identity for details / restore / known-field reopen. */
export const effectiveIdentityForState = (state: ClinicState) => {
  const draft = state.bookingDraft;
  const identity = resolveContactIdentity(state.contactContext, draft?.contactId);
  const open =
    state.pendingInteraction?.kind === "contact_field"
      ? state.pendingInteraction
      : null;
  return {
    identity,
    details: effectiveBookingContactDetails({
      crmContact: identity.kind === "owned" ? identity.contact : null,
      contactDetails: draft?.contactDetails ?? null,
      ...(open?.collected != null ? { collected: open.collected } : {}),
    }),
  };
};

/**
 * Occupied-phone HITL: retry linking when the candidate row is free,
 * otherwise reopen phoneNumber as occupied (never advance to names).
 */
export const reopenOccupiedPhoneOrRetryLink = (
  state: ClinicState,
): { replyText: string; interaction: PendingInteraction } | null => {
  const draft = state.bookingDraft;
  if (draft == null) {
    return null;
  }
  const { identity } = effectiveIdentityForState(state);
  if (identity.kind === "phone_candidate" && phoneCandidateHasLinkableRow(identity)) {
    return {
      replyText: PATIENT_FALLBACK_MESSAGE,
      interaction: state.pendingInteraction ?? {
        kind: "contact_field",
        field: "phoneNumber",
        choices: [],
      },
    };
  }
  const session = reduceBookingSession(
    {
      bookingDraft: draft,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "contact_field_required", field: "phoneNumber", occupied: true },
  );
  if (session.pendingInteraction == null) {
    return null;
  }
  return {
    replyText: String(renderBookingInteractionMessage(session.pendingInteraction).content),
    interaction: session.pendingInteraction,
  };
};

/** Runtime-owned contact ladder once service, slot, and note are complete. */
export const bookingDetailsInteraction = (
  state: ClinicState,
): { replyText: string; interaction: PendingInteraction } | null => {
  if (!bookingDetailsReady(state)) {
    return null;
  }
  const draft = state.bookingDraft!;
  const { identity, details } = effectiveIdentityForState(state);
  if (identity.kind === "phone_candidate") {
    return reopenOccupiedPhoneOrRetryLink(state);
  }
  const field = nextMissingContactField(details);
  if (field == null) {
    return null;
  }
  const session = reduceBookingSession(
    {
      bookingDraft: draft,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    { type: "contact_field_required", field },
  );
  if (session.pendingInteraction == null) {
    return null;
  }
  return {
    replyText: String(renderBookingInteractionMessage(session.pendingInteraction).content),
    interaction: session.pendingInteraction,
  };
};

/**
 * Non-AI contact-write / phone-lookup failure replies.
 * Returns a state update when this turn is owned by contact failure handling.
 */
export const finalizeNonAiContactFailures = (
  agent: ClinicAgentDefinition,
  state: ClinicState,
  cleared: ClearedTape,
  confirmationCleanup: ClinicStateUpdate,
): ClinicStateUpdate | null => {
  if (agent.id === BOOKING_AGENT_ID && phoneLookupFailedThisTurn(state)) {
    trackEvent("contact_write_failed", {
      tool: "find_contact_by_phone",
      category: "operational",
    });
    const pendingInteraction = state.pendingInteraction?.kind === "contact_field"
      ? null
      : state.pendingInteraction ?? null;
    return {
      ...cleared,
      ...confirmationCleanup,
      pendingInteraction,
      messages: [tagRuntimeAgentMessage(new AIMessage(BOOKING_CONTACT_SAVE_FAILED_UK), agent.id)],
      lastHandoff: {
        agentId: agent.id,
        agentName: agent.name,
        status: "ok",
        replyText: BOOKING_CONTACT_SAVE_FAILED_UK,
      },
    };
  }
  if (agent.id === BOOKING_AGENT_ID) {
    const contactWrite = terminalContactWriteOutcome(state);
    if (contactWrite != null) {
      const { classification } = contactWrite;
      trackEvent("contact_write_failed", {
        tool: classification.tool,
        category: classification.category ?? classification.outcome,
      });
      const { details } = effectiveIdentityForState(state);
      let pendingInteraction = state.pendingInteraction ?? null;
      let replyText = BOOKING_CONTACT_SAVE_FAILED_UK;
      let replyButtons: string[] = [];
      if (classification.outcome === "known_field") {
        if (classification.error === CONTACT_LINK_CANDIDATE_REQUIRED_ERROR) {
          const occupied = reopenOccupiedPhoneOrRetryLink(state);
          if (occupied != null) {
            replyText = occupied.replyText;
            pendingInteraction = occupied.interaction;
            replyButtons = replyButtonsForInteraction(occupied.interaction);
          }
        } else {
          // Same ladder as details-step: never reopen a field already on CRM∪draft∪collected.
          const reopen = nextMissingContactField(details);
          if (reopen != null) {
            const session = reduceBookingSession(
              {
                bookingDraft: state.bookingDraft ?? null,
                pendingInteraction,
              },
              { type: "contact_field_required", field: reopen },
            );
            pendingInteraction = session.pendingInteraction;
            if (pendingInteraction != null) {
              replyText = String(
                renderBookingInteractionMessage(pendingInteraction).content,
              );
              replyButtons = replyButtonsForInteraction(pendingInteraction);
            }
          } else {
            pendingInteraction = null;
          }
        }
      } else {
        // Operational: clear completed contact_field; keep contactDetails + slot.
        if (pendingInteraction?.kind === "contact_field") {
          pendingInteraction = null;
        }
      }
      return {
        ...cleared,
        ...confirmationCleanup,
        pendingInteraction,
        ...(replyText === BOOKING_PHONE_OCCUPIED_UK ? { contactContext: null } : {}),
        messages: [tagRuntimeAgentMessage(new AIMessage(replyText), agent.id)],
        lastHandoff: {
          agentId: agent.id,
          agentName: agent.name,
          status: "ok",
          replyText,
          ...(replyButtons.length > 0 ? { replyButtons } : {}),
        },
      };
    }
  }
  return null;
};

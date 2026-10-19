/**
 * Thin LangGraph adapters for the decide/effect loop (DDD-277).
 * Compiled interrupt-capable node name `booking__tools` must remain the HITL
 * resume target through compatibility release 6A.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";

import {
  bookingDecisionToCommandOutcome,
  readModelsFromClinicState,
  sessionFromClinicState,
} from "../booking-decide-adapter.js";
import { decideBooking } from "../booking-domain/decide.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import { projectBookingView } from "../booking-domain/view.js";
import { recoverExpiredConfirmBookingHitl } from "../booking-hitl-recovery.js";
import { sessionToBookingDraft } from "../booking-session-convert.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { stampBookingEffect, assertStampedBookingToolCall } from "./stamp-booking-effect.js";

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
 * Patient turn or typed EffectResult → interpreter → decideBooking → state update.
 * Does not inspect the ToolMessage tape beyond typed effect results passed in update.
 */
export const createBookingDecideNode = () =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const session = sessionFromClinicState(state);
    if (session == null) {
      return {};
    }
    const readModels = readModelsFromClinicState(state);
    const rawText = lastHumanText(state.messages);
    const patch = interpretBookingTurnDeterministic({ rawText });
    const input = Object.keys(patch).length > 0
      ? { source: "semantic_patch" as const, patch }
      : { source: "patient_turn" as const, rawText };
    const decision = decideBooking(session, input, readModels);
    const outcome = bookingDecisionToCommandOutcome(decision);
    if (outcome.kind === "execute") {
      const stamped = stampBookingEffect(
        decision.tag === "effect" || decision.tag === "mutation_confirm"
          ? decision.pendingEffect
          : {
              id: outcome.toolCall.id,
              expectedRevision: session.revision,
              effect: { kind: "get_working_time" },
              status: "prepared",
            },
      );
      assertStampedBookingToolCall(stamped);
      const view = projectBookingView({ session: decision.session ?? session, readModels });
      return {
        ...outcome.update,
        bookingDraft: decision.session != null
          ? sessionToBookingDraft(decision.session)
          : null,
        agentMessages: [
          new AIMessage({
            content: view.replyText,
            tool_calls: [{
              id: stamped.id,
              name: stamped.name,
              args: stamped.args,
              type: "tool_call",
            }],
          }),
        ],
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

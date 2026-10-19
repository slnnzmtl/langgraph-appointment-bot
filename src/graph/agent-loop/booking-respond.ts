/**
 * Non-authoritative booking response node.
 * Receives a closed semantic decision, binds no tools, emits patient text only.
 * Buttons stay code-owned from the decision card.
 */

import { z } from "zod";

import { trackEvent } from "../../analytics/track.js";
import { claimsOutcome } from "../../shared/outcome-claims.js";
import type { BookingDecision } from "../booking-domain/decision.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { BOOKING_AGENT_ID, type ILLMConnector } from "../types.js";
import { replyChoicesFromCard } from "./booking-card-choices.js";
import {
  bookingResponseFallback,
  bookingSuccessText,
} from "./booking-response-fallback.js";

const patientTextSchema = z.object({
  text: z.string().min(1).max(2000),
}).strict();

export const BOOKING_RESPOND_NODE = "booking__respond" as const;

export const BOOKING_RESPONSE_INSTRUCTION = `You write one short patient-facing Telegram message for a clinic booking bot.

You receive a closed semantic intent and verified facts only.
Rules:
- Output patient text only. Never invent routing, tool calls, mutations, or choice ids.
- Use only the facts provided. Do not invent prices, addresses, hours, services, or times.
- Match the patient's language when obvious from prior context; default Ukrainian.
- Keep the message concise (1–3 sentences).
- Do not claim an administrator was connected for handoff.
- Never claim a visit was created, confirmed, cancelled, or rescheduled unless intent is exactly "success".
- For ask/confirm_service/present_dates/present_times, invite the next step; do not announce completion.`;

type ClosedDecisionChannel = {
  bookingDecision?: BookingDecision | null;
};

export type CreateBookingRespondOptions = {
  llm: ILLMConnector;
  agentName?: string;
};

const isCommittedSuccess = (decision: BookingDecision): boolean =>
  decision.intent === "success"
  && decision.tag === "terminal"
  && decision.reason === "success";

export const createBookingRespondNode = (options: CreateBookingRespondOptions) => {
  const chain = options.llm.bindRoutingTools(patientTextSchema, {
    name: "booking_patient_reply",
  });
  const agentName = options.agentName ?? "booking";

  return async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const decision = (state as ClinicState & ClosedDecisionChannel).bookingDecision;
    if (decision == null) {
      return {
        lastHandoff: {
          agentId: BOOKING_AGENT_ID,
          agentName,
          status: "empty",
          replyText: bookingResponseFallback({ intent: "idle" }),
        },
      };
    }

    const choices = replyChoicesFromCard(decision.card);
    const fallback = bookingResponseFallback({
      intent: decision.intent,
      facts: decision.facts,
      card: decision.card,
    });

    // Committed mutation only — code-owned success text, no model prose.
    if (isCommittedSuccess(decision)) {
      return {
        bookingDecision: null,
        lastHandoff: {
          agentId: BOOKING_AGENT_ID,
          agentName,
          status: "ok",
          replyText: bookingSuccessText(decision.facts),
          replyButtons: choices.map((choice) => choice.label),
          replyChoices: choices,
        },
      };
    }

    // Non-success intents: model may help, but never ship outcome claims.
    let text = fallback;
    try {
      const result = await chain.invoke([
        { role: "system", content: BOOKING_RESPONSE_INSTRUCTION },
        {
          role: "user",
          content: JSON.stringify({
            intent: decision.intent,
            facts: decision.facts,
            tag: decision.tag,
            reason: decision.reason ?? null,
          }),
        },
      ]);
      const parsed = patientTextSchema.safeParse(result);
      if (parsed.success && parsed.data.text.trim().length > 0) {
        const candidate = parsed.data.text.trim();
        const claim = claimsOutcome(candidate);
        if (claim != null) {
          trackEvent("false_success_claim", {
            rule: claim.rule,
            phase: state.bookingDraft?.phase ?? null,
            agent: BOOKING_AGENT_ID,
            intent: decision.intent,
          });
          text = fallback;
        } else {
          text = candidate;
        }
      }
    } catch {
      text = fallback;
    }

    // Intent "success" without terminal/committed path is also a false claim.
    if (decision.intent === "success" && !isCommittedSuccess(decision)) {
      trackEvent("false_success_claim", {
        rule: "intent_success_without_commit",
        phase: state.bookingDraft?.phase ?? null,
        agent: BOOKING_AGENT_ID,
        intent: decision.intent,
      });
      text = fallback;
    }

    return {
      bookingDecision: null,
      lastHandoff: {
        agentId: BOOKING_AGENT_ID,
        agentName,
        status: "ok",
        replyText: text,
        replyButtons: choices.map((choice) => choice.label),
        replyChoices: choices,
      },
    };
  };
};

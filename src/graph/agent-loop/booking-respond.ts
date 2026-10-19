/**
 * Non-authoritative booking response node.
 * Receives a closed semantic decision, binds no tools, emits patient text only.
 * Buttons stay code-owned from the decision card.
 */

import { z } from "zod";

import type { BookingDecision } from "../booking-domain/decision.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { BOOKING_AGENT_ID, type ILLMConnector } from "../types.js";
import { replyChoicesFromCard } from "./booking-card-choices.js";
import { bookingResponseFallback } from "./booking-response-fallback.js";

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
- For success, mention the provided service/date/time/address facts when present.`;

type ClosedDecisionChannel = {
  bookingDecision?: BookingDecision | null;
};

export type CreateBookingRespondOptions = {
  llm: ILLMConnector;
  agentName?: string;
};

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
    });

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
        text = parsed.data.text.trim();
      }
    } catch {
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

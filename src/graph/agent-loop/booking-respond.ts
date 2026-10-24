/**
 * Non-authoritative booking response node.
 * Receives a closed semantic decision, binds no tools, emits patient text only.
 * Buttons stay code-owned from the decision card (reply keyboard only).
 */

import { z } from "zod";
import { AIMessage } from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";
import {
  MAIN_MENU_GREETING_UK,
  PATIENT_FALLBACK_MESSAGE,
  defaultMenuLabels,
} from "../../shared/clinic-constants.js";
import {
  resolvePatientLocale,
  type ConversationLocale,
} from "../../shared/conversation-locale.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { claimsOutcome } from "../../shared/outcome-claims.js";
import type {
  BookingDecision,
  BookingVerifiedFacts,
} from "../booking-domain/decision.js";
import {
  renderBookingInteractionMessage,
} from "../booking/booking-interaction-render.js";
import { reduceBookingDraft } from "../booking/booking-draft.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { BOOKING_AGENT_ID, type ILLMConnector } from "../types.js";
import { replyChoicesFromCard } from "./booking-card-choices.js";
import {
  bookingResponseFallback,
  bookingSuccessText,
  clarificationCopy,
} from "./booking-response-fallback.js";
import { defaultMenuHasVisit } from "./mutation-finalize.js";
import { tagRuntimeAgentMessage } from "../context/sub-agent-messages.js";

/** Code-owned side-question sentence(s) from allowlisted facts only. */
const sideQuestionFactPrefix = (
  facts: BookingVerifiedFacts,
  locale: ConversationLocale,
): string | null => {
  const lines: string[] = [];
  const price = facts.servicePrice?.trim();
  if (price != null && price.length > 0) {
    const name = facts.serviceName?.trim();
    const withCurrency = /грн|uah|uah\b/i.test(price)
      ? price
      : locale === "en"
        ? `${price} UAH`
        : `${price} грн`;
    lines.push(
      locale === "en"
        ? (name != null && name.length > 0
          ? `The price of ${name} is ${withCurrency}.`
          : `The price is ${withCurrency}.`)
        : (name != null && name.length > 0
          ? `Вартість ${name} становить ${withCurrency}.`
          : `Вартість становить ${withCurrency}.`),
    );
  }
  const hours = facts.hours?.trim();
  if (hours != null && hours.length > 0) {
    lines.push(hours);
  }
  const address = facts.address?.trim();
  if (address != null && address.length > 0) {
    lines.push(locale === "en" ? `Address: ${address}` : `Адреса: ${address}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return lines.join("\n");
};

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

const isTerminalLeave = (decision: BookingDecision): boolean =>
  decision.tag === "terminal"
  && (decision.intent === "menu" || decision.intent === "abandon");

export const createBookingRespondNode = (options: CreateBookingRespondOptions) => {
  const chain = options.llm.bindRoutingTools(patientTextSchema, {
    name: "booking_patient_reply",
  });
  const agentName = options.agentName ?? "booking";

  // Keep durable conversation history aligned with the handoff Telegram sends.
  // Booking replies are runtime-authored and do not pass through specialist finalize.
  const replyUpdate = (
    replyText: string,
    status: "ok" | "empty",
    replyButtons: string[] = [],
    extra: ClinicStateUpdate = {},
  ): ClinicStateUpdate => ({
    ...extra,
    messages: [tagRuntimeAgentMessage(new AIMessage(replyText), BOOKING_AGENT_ID)],
    lastHandoff: {
      agentId: BOOKING_AGENT_ID,
      agentName,
      status,
      replyText,
      replyButtons,
    },
  });

  return async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const decision = (state as ClinicState & ClosedDecisionChannel).bookingDecision;
    if (decision == null) {
      return replyUpdate(bookingResponseFallback({ intent: "idle" }), "empty");
    }

    const locale = resolvePatientLocale(state);
    const choices = replyChoicesFromCard(decision.card, undefined, locale);
    const replyButtons = choices.map((choice) => choice.label);
    const fallback = bookingResponseFallback({
      intent: decision.intent,
      facts: decision.facts,
      card: decision.card,
      locale,
    });

    // Committed mutation only — code-owned success text, no model prose.
    if (isCommittedSuccess(decision)) {
      let hasVisit: boolean;
      switch (decision.facts.action) {
        case "cancel":
          hasVisit = false;
          break;
        case "create":
        case "reschedule":
          hasVisit = true;
          break;
        default:
          hasVisit = defaultMenuHasVisit(
            state.agentMessages ?? [],
            state.bookingContext,
          );
          break;
      }
      return replyUpdate(bookingSuccessText(decision.facts), "ok", [
        ...defaultMenuLabels(hasVisit),
      ], { bookingDecision: null });
    }

    // HITL leave / ❌ — same main-menu exit as supervisor (no LLM).
    if (isTerminalLeave(decision)) {
      const hasVisit = defaultMenuHasVisit(
        state.agentMessages ?? [],
        state.bookingContext,
      );
      return replyUpdate(MAIN_MENU_GREETING_UK, "ok", [
        ...defaultMenuLabels(hasVisit),
      ], { bookingDecision: null });
    }

    // Open cards: matching pendingInteraction is the sole listed-copy path.
    // Side-question facts (price/hours/address) and catalog-miss clarification
    // prefix that listed copy — no LLM.
    if (decision.card != null) {
      let replyText = fallback;
      const pending = state.pendingInteraction;
      if (pending != null && pending.kind === decision.card.kind) {
        const listed = extractMessageTextContent(
          renderBookingInteractionMessage(pending, locale).content,
        ).trim();
        if (listed.length > 0) {
          replyText = listed;
        }
      }
      // Verified facts and failure/open-step copy both prefix the listed card —
      // do not drop price when clarificationReason is set (availability errors).
      const factPrefix = sideQuestionFactPrefix(decision.facts, locale);
      const clarificationPrefix = clarificationCopy(
        decision.facts?.clarificationReason,
        locale,
      );
      const grounded: string[] = [];
      if (factPrefix != null) {
        grounded.push(factPrefix);
      }
      if (
        clarificationPrefix != null
        && clarificationPrefix !== replyText
      ) {
        grounded.push(clarificationPrefix);
      }
      if (grounded.length > 0) {
        replyText = replyText.trim().length > 0
          && !grounded.includes(replyText)
          ? `${grounded.join("\n\n")}\n\n${replyText}`
          : grounded.join("\n\n");
      }
      // REPLACE cancel continue: composer owns the cancel ack (not FAQ tool-tape scan).
      const replaceCancelAck = state.bookingDraft?.replaceCancelAck === true
        || decision.facts?.cancelAcknowledged === true;
      let draftWorking = state.bookingDraft;
      if (replaceCancelAck) {
        const cancelAck = "Запис скасовано.";
        replyText = replyText.trim().length > 0
          ? `${cancelAck}\n\n${replyText}`
          : cancelAck;
        if (draftWorking?.replaceCancelAck === true) {
          draftWorking = reduceBookingDraft(draftWorking, {
            type: "replace_cancel_ack_cleared",
          });
        }
      }
      // One-shot reply facts: clear after the composer prefixes them.
      if (draftWorking?.pendingReplyFacts != null) {
        draftWorking = reduceBookingDraft(draftWorking, {
          type: "reply_facts_cleared",
        });
      }
      return replyUpdate(replyText, "ok", replyButtons, {
        bookingDecision: null,
        ...(draftWorking !== state.bookingDraft
          ? { bookingDraft: draftWorking }
          : {}),
      });
    }

    // Open effects belong in decide→tools, not here. Belt-and-suspenders if
    // routing regresses: never ask for a date/time with an empty keyboard.
    if (decision.tag === "effect") {
      return replyUpdate(PATIENT_FALLBACK_MESSAGE, "ok", [], { bookingDecision: null });
    }

    // Card-less intents: model may help, but never ship outcome claims.
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
    // Do not reuse bookingSuccessText (that is only for committed terminal success).
    if (decision.intent === "success" && !isCommittedSuccess(decision)) {
      trackEvent("false_success_claim", {
        rule: "intent_success_without_commit",
        phase: state.bookingDraft?.phase ?? null,
        agent: BOOKING_AGENT_ID,
        intent: decision.intent,
      });
      text = bookingResponseFallback({ intent: "idle" });
    }

    return replyUpdate(text, "ok", replyButtons, { bookingDecision: null });
  };
};

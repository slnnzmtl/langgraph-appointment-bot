/**
 * Bounded structured LLM interpreter for free-form booking turns.
 * Deterministic choice-id / structural parsing lives in booking-domain/interpret.
 */

import { z } from "zod";

import {
  BOOKING_TURN_INTERPRETER_INSTRUCTION,
  interpretBookingTurnDeterministic,
  type InterpretBookingTurnInput,
  normalizeBookingTurnClassification,
} from "../booking-domain/interpret.js";
import type { UnderstoodBookingTurn } from "../booking-domain/turn.js";
import type { ILLMConnector } from "../types.js";

const bookingTurnClassificationSchema = z.object({
  serviceIntentKind: z
    .enum([
      "none",
      "consultation",
      "named_procedure",
      "catalog_browse",
      "confirm_pending_service",
      "decline_pending_service",
      "book_highlighted",
    ])
    .optional(),
  serviceQuery: z.string().min(1).max(120).optional(),
  scheduleKind: z
    .enum(["none", "date", "time", "date_and_time", "relative", "choice"])
    .optional(),
  scheduleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scheduleTime: z.string().max(16).optional(),
  relativeQueryKind: z.enum(["nearest", "earlier", "later"]).optional(),
  noteKind: z.enum(["none", "answer", "skip"]).optional(),
  noteValue: z.string().min(1).max(500).optional(),
  phoneNumber: z.string().min(5).max(32).optional(),
  firstName: z.string().min(1).max(48).optional(),
  lastName: z.string().min(1).max(48).optional(),
  informationalQuestion: z.string().min(1).max(240).optional(),
  faqTopic: z.enum(["hours", "address", "price", "catalog", "other"]).optional(),
  controlKind: z
    .enum([
      "none",
      "main_menu",
      "abandon",
      "human_handoff",
      "hitl_yes",
      "hitl_no",
      "return_to_booking",
      "visit_status",
      "visit_cancel",
      "visit_reschedule",
      "greeting",
      "help",
    ])
    .optional(),
  sideQuestionKind: z
    .enum(["none", "hours", "address", "price", "catalog", "other"])
    .optional(),
}).strict();

export type InterpretBookingTurn = (
  input: InterpretBookingTurnInput,
) => Promise<UnderstoodBookingTurn>;

export const createBookingTurnInterpreter = (llm: ILLMConnector): InterpretBookingTurn => {
  const chain = llm.bindRoutingTools(bookingTurnClassificationSchema, {
    name: "interpret_booking_turn",
  });

  return async (input) => {
    const deterministic = interpretBookingTurnDeterministic(input);
    if (Object.keys(deterministic).length > 0) {
      return deterministic;
    }
    const rawText = input.rawText.trim();
    if (rawText.length === 0) {
      return {};
    }

    const offeredLabels = input.offeredChoiceLabels ?? [];
    const offeredIds = input.offeredChoiceIds ?? [];
    const offeredPairs = offeredIds.map((id, index) => {
      const label = offeredLabels[index];
      return label != null && label.length > 0 ? `${id}=${label}` : id;
    });

    const contextLines = [
      input.awaitingNote === true ? "Open field: visit note (or skip)." : null,
      input.awaitingContactField != null
        ? `Open field: contact ${input.awaitingContactField}.`
        : null,
      input.awaitingServiceConfirm === true ? "Open field: pending service confirmation." : null,
      input.faqHighlightOpen === true
        ? "Idle FAQ context: one highlighted catalog row is informational until the patient explicitly books it (book_highlighted). Consultation requests stay consultation."
        : null,
      input.activeRequirement != null
        ? `Active booking requirement: ${input.activeRequirement}.`
        : null,
      input.kyivDate != null ? `Kyiv date today: ${input.kyivDate}.` : null,
      input.locale != null ? `Patient locale hint: ${input.locale}.` : null,
      offeredPairs.length > 0
        ? `Offered choices (ids and labels; do not invent): ${offeredPairs.join("; ")}`
        : null,
    ].filter((line): line is string => line != null);

    // Names require an explicit LLM firstName/lastName — never invent from raw text.
    // Phone still gets a format clarification when the patch is empty.
    const phoneFormatFallback = (): UnderstoodBookingTurn =>
      input.awaitingContactField === "phoneNumber"
        ? { contactFormatError: "phoneNumber" }
        : {};

    try {
      const result = await chain.invoke([
        { role: "system", content: BOOKING_TURN_INTERPRETER_INSTRUCTION },
        {
          role: "user",
          content: `${contextLines.join("\n")}\nPatient message:\n${rawText}`,
        },
      ]);
      const parsed = bookingTurnClassificationSchema.safeParse(result);
      if (!parsed.success) {
        return phoneFormatFallback();
      }
      // Strip explicit undefined keys for exactOptionalPropertyTypes.
      const cleaned = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined),
      );
      const patch = normalizeBookingTurnClassification(cleaned, input);
      if (Object.keys(patch).length > 0) {
        return patch;
      }
      // Open phone field, no other semantic intent — format clarification.
      // Open name field with empty classification — leave unanswered (re-ask).
      return phoneFormatFallback();
    } catch {
      return phoneFormatFallback();
    }
  };
};

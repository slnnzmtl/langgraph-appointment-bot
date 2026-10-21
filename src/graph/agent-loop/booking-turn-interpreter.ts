/**
 * Bounded structured LLM interpreter for free-form booking turns.
 * Deterministic choice-id / structural parsing lives in booking-domain/interpret.
 */

import { z } from "zod";

import {
  BOOKING_TURN_INTERPRETER_INSTRUCTION,
  interpretBookingTurnDeterministic,
  isStructuralNameToken,
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
    ])
    .optional(),
  serviceQuery: z.string().min(1).max(120).optional(),
  // Intentionally omitted from authoritative path: CRM ids resolve via list_services.
  serviceId: z.string().min(1).max(64).optional(),
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
    ])
    .optional(),
  sideQuestionKind: z.enum(["none", "hours", "address", "price", "catalog"]).optional(),
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

    const contextLines = [
      input.awaitingNote === true ? "Open field: visit note (or skip)." : null,
      input.awaitingContactField != null
        ? `Open field: contact ${input.awaitingContactField}.`
        : null,
      input.awaitingServiceConfirm === true ? "Open field: pending service confirmation." : null,
      input.offeredChoiceIds != null && input.offeredChoiceIds.length > 0
        ? `Offered choice ids (callback only; do not invent): ${input.offeredChoiceIds.join(", ")}`
        : null,
    ].filter((line): line is string => line != null);

    const emptyPatchFallback = (): UnderstoodBookingTurn => {
      if (input.awaitingContactField === "phoneNumber") {
        return { contactFormatError: "phoneNumber" };
      }
      // Mirror phone: after empty LLM patch, accept a structural name token so
      // Latin given names (e.g. Smoke) do not stall when the model omits firstName.
      if (
        (input.awaitingContactField === "firstName"
          || input.awaitingContactField === "lastName")
        && isStructuralNameToken(rawText)
      ) {
        return input.awaitingContactField === "firstName"
          ? { contactFacts: { firstName: rawText } }
          : { contactFacts: { lastName: rawText } };
      }
      return {};
    };

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
        return emptyPatchFallback();
      }
      // Strip explicit undefined keys for exactOptionalPropertyTypes.
      const cleaned = Object.fromEntries(
        Object.entries(parsed.data).filter(([, value]) => value !== undefined),
      );
      const patch = normalizeBookingTurnClassification(cleaned, input);
      if (Object.keys(patch).length > 0) {
        return patch;
      }
      // Open phone → format clarification; open name → structural token.
      return emptyPatchFallback();
    } catch {
      return emptyPatchFallback();
    }
  };
};

import { z } from "zod";

import {
  FINISH_ROUTE,
  type ClinicAgentDefinition,
  type ClinicRouteId,
} from "./types.js";

const PLACEHOLDER_REPLY_VALUES = new Set(["null", "undefined", "none", "n/a"]);

export const normalizeSupervisorReply = (reply: string | undefined): string | undefined => {
  if (typeof reply !== "string") {
    return undefined;
  }

  const trimmed = reply.trim();
  if (trimmed.length === 0 || PLACEHOLDER_REPLY_VALUES.has(trimmed.toLowerCase())) {
    return undefined;
  }

  return trimmed;
};

export const SUPERVISOR_MENU_VALUES = ["default", "visit_change"] as const;
export type SupervisorMenu = (typeof SUPERVISOR_MENU_VALUES)[number];

export const SUPERVISOR_INTENT_VALUES = [
  "visit_status",
  "visit_cancel",
  "visit_reschedule",
  "book",
  "consultation_request",
  "faq",
  "abandon_booking",
  "other",
] as const;
export type SupervisorIntent = (typeof SUPERVISOR_INTENT_VALUES)[number];

export type ClinicRoutingDecision = {
  next: ClinicRouteId;
  reply?: string;
  /** FINISH only: which keyboard the graph attaches (model does not emit trailers). */
  menu?: SupervisorMenu;
  /**
   * Free-text patient intent when not an exact open-interaction chip label.
   * Omit on chip taps — the graph resolves those before the model runs.
   */
  intent?: SupervisorIntent;
  /** Must match an id from `<open_interaction>` when the patient picked an open choice in free text. */
  choiceId?: string;
};

export const buildClinicRoutingSchema = (agents: ClinicAgentDefinition[]) => {
  const agentIds = agents.map((agent) => agent.id);
  const nextValues = [FINISH_ROUTE, ...agentIds] as [ClinicRouteId, ...ClinicRouteId[]];

  const description = [
    "The next graph node to execute.",
    "Use FINISH for general chat or any request you can answer directly.",
    "Route to a specialist id when the request clearly matches one of these:",
    ...agents.map((agent) => `- ${agent.id}: ${agent.description}`),
  ].join(" ");

  return z.object({
    next: z.enum(nextValues).describe(description),
    reply: z
      .string()
      .optional()
      .describe("Patient-facing text. Required iff next=FINISH. Omit when delegating."),
    menu: z
      .enum(SUPERVISOR_MENU_VALUES)
      .optional()
      .describe(
        "FINISH only. visit_change when asking to move/cancel a listed visit; otherwise default (including greetings that merely list visits). Omit when next is not FINISH.",
      ),
    intent: z
      .enum(SUPERVISOR_INTENT_VALUES)
      .optional()
      .describe(
        "Patient intent for free text. visit_status = read-only «what is booked»; visit_cancel / visit_reschedule = change a visit; abandon_booking = leave an in-progress booking without a slot; consultation_request = wants consultation; book = new booking; faq = clinic info browse. Omit when delegating via next only.",
      ),
    choiceId: z
      .string()
      .optional()
      .describe(
        "When the patient clearly picks one open_interaction choice in free text, its id from <open_interaction>. Never invent ids.",
      ),
  });
};

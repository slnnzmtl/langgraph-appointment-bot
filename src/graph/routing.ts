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

export type ClinicRoutingDecision = {
  next: ClinicRouteId;
  reply?: string;
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
  });
};

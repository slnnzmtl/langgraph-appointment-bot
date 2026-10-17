import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  BOOKING_INFORMATIONAL_TOOL_NAMES,
  BOOKING_RUNTIME_TOOL_NAMES,
} from "../tools/index.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentId,
} from "./types.js";

/**
 * Fail closed at graph composition: LLM-bound names must match agent ownership.
 * Booking LLM binds informational reads only; FAQ must not bind runtime-owned tools.
 */
export const assertBoundAgentToolNames = (
  agentId: ClinicAgentId,
  boundTools: readonly StructuredToolInterface[],
): void => {
  const names = boundTools.map((tool) => tool.name);
  if (agentId === BOOKING_AGENT_ID) {
    const disallowed = names.filter((name) => !BOOKING_INFORMATIONAL_TOOL_NAMES.has(name));
    if (disallowed.length > 0) {
      throw new Error(
        `Booking LLM bind includes non-informational tools: ${disallowed.join(", ")}`,
      );
    }
    return;
  }
  if (agentId === FAQ_AGENT_ID) {
    const runtime = names.filter((name) => BOOKING_RUNTIME_TOOL_NAMES.has(name));
    if (runtime.length > 0) {
      throw new Error(
        `FAQ LLM bind includes runtime-owned tools: ${runtime.join(", ")}`,
      );
    }
  }
};

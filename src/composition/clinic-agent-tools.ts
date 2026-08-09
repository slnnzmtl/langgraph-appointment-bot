import type { StructuredToolInterface } from "@langchain/core/tools";

import type { AppConfig } from "../config.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
} from "../graph/types.js";
import { createBookingTools, createReadTools } from "../tools/index.js";
import type { ClinicAdapters } from "./clinic-adapters.js";

/** Build FAQ/booking tool lists. callTool is read via adapters each invoke so smoke can wrap it. */
export const buildClinicAgentTools = (
  config: AppConfig,
  adapters: ClinicAdapters,
): Record<string, StructuredToolInterface[]> => {
  const callTool: typeof adapters.callTool = (name, args) => adapters.callTool(name, args);
  const readTools = createReadTools({ callTool });
  const bookingTools = createBookingTools({
    callTool,
    assignedUserId: config.assignedUserId,
  });

  return {
    [FAQ_AGENT_ID]: readTools,
    [BOOKING_AGENT_ID]: [...readTools, ...bookingTools],
  };
};

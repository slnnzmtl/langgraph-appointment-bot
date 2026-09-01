import type { StructuredToolInterface } from "@langchain/core/tools";

import type { AppConfig } from "../config.js";
import { BOOKING_AGENT_ID } from "../graph/types.js";
import { createBookingTools, createReadTools } from "../tools/index.js";
import type { ClinicAdapters } from "./clinic-adapters.js";

export const buildClinicAgentTools = (
  config: AppConfig,
  adapters: ClinicAdapters,
): Record<string, StructuredToolInterface[]> => {
  const callTool: typeof adapters.callTool = (name, args) => adapters.callTool(name, args);
  const readTools = createReadTools({
    callTool,
    assignedUserId: config.assignedUserId,
  });
  const bookingTools = createBookingTools({
    callTool,
    assignedUserId: config.assignedUserId,
  });

  return {
    [BOOKING_AGENT_ID]: [...readTools, ...bookingTools],
  };
};

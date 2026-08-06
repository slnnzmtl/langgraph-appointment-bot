import type { CapabilityProvider } from "@personal-assistant/supervisor-framework";

import type { AppConfig } from "../config.js";
import { createBookingTools, createReadTools } from "../tools/clinic-tools.js";
import type { ClinicAdapters } from "./clinic-adapters.js";

export const ESPOCRM_READ_CAPABILITY_ID = "espocrm-read" as const;
export const ESPOCRM_BOOKING_CAPABILITY_ID = "espocrm-booking" as const;

export type BuildClinicCapabilityProvidersInput = {
  config: AppConfig;
  adapters: ClinicAdapters;
};

export const buildClinicCapabilityProviders = ({
  config,
  adapters,
}: BuildClinicCapabilityProvidersInput): CapabilityProvider<Record<string, unknown>>[] => {
  // Delegate through adapters.callTool each invoke so smoke can wrap the property.
  const callTool: typeof adapters.callTool = (name, args) => adapters.callTool(name, args);

  return [
    {
      descriptor: {
        id: ESPOCRM_READ_CAPABILITY_ID,
        description: "Read clinic services and FAQ content from EspoCRM.",
        grantable: true,
      },
      isAvailable: () => true,
      resolveTools: () => createReadTools({ callTool }),
    },
    {
      descriptor: {
        id: ESPOCRM_BOOKING_CAPABILITY_ID,
        description:
          "Find/create contacts (cTelegram identity), and create meetings with HITL confirm.",
        grantable: false,
        reservedForAgentIds: ["booking"],
      },
      isAvailable: () => true,
      resolveTools: () =>
        createBookingTools({
          callTool,
          assignedUserId: config.assignedUserId,
        }),
    },
  ];
};

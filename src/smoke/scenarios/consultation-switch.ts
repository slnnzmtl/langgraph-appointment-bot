import { runConsultationSwitchSmoke } from "../consultation-switch.js";
import type { SmokeScenario } from "../types.js";

export const consultationSwitchScenario: SmokeScenario = {
  name: "consultation-switch",
  tier: "deterministic",
  run: async () => {
    await runConsultationSwitchSmoke();
  },
};

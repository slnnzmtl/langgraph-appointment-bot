import type { SmokeScenario, SmokeTier } from "../types.js";
import { bootstrapScenario } from "./bootstrap.js";
import {
  bookDeclineScenario,
  bookNewContactScenario,
  cancelHitlFaqScenario,
  cancelScenario,
  doubleBookGuardScenario,
  hitlTypedScenario,
  ownershipScenario,
  pendingConfirmTextScenario,
  rescheduleScenario,
} from "./booking-write.js";
import { consultationSwitchScenario } from "./consultation-switch.js";
import {
  faqCatalogScenario,
  faqChooseOtherScenario,
  faqHoursScenario,
  faqPriceScenario,
  offerPriceScenario,
} from "./faq.js";
import { identityScenario } from "./identity.js";
import { reminderWebhookScenario } from "./reminder-webhook.js";
import { supervisorMenuScenario } from "./supervisor-menu.js";

export const ALL_SCENARIOS: SmokeScenario[] = [
  bootstrapScenario,
  consultationSwitchScenario,
  faqHoursScenario,
  faqCatalogScenario,
  faqPriceScenario,
  faqChooseOtherScenario,
  offerPriceScenario,
  supervisorMenuScenario,
  identityScenario,
  bookDeclineScenario,
  bookNewContactScenario,
  pendingConfirmTextScenario,
  doubleBookGuardScenario,
  rescheduleScenario,
  cancelScenario,
  cancelHitlFaqScenario,
  hitlTypedScenario,
  ownershipScenario,
  reminderWebhookScenario,
];

export const scenariosForTiers = (
  tiers: SmokeTier[],
  only?: Set<string>,
): SmokeScenario[] => {
  const tierSet = new Set(tiers);
  return ALL_SCENARIOS.filter((scenario) => {
    if (!tierSet.has(scenario.tier)) {
      return false;
    }
    if (only && only.size > 0 && !only.has(scenario.name)) {
      return false;
    }
    return true;
  });
};

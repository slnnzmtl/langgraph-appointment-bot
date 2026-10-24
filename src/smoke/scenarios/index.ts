import type { SmokeScenario, SmokeTier } from "../types.js";
import { bootstrapScenario } from "./bootstrap.js";
import { bookingFreeTextTypedSlotScenario } from "./booking-invoke.js";
import {
  bookDeclineScenario,
  bookNewContactScenario,
  bookProcedureScenario,
  cancelHitlFaqScenario,
  cancelScenario,
  contactLinkScenario,
  doubleBookGuardScenario,
  hitlTypedScenario,
  ownershipScenario,
  pendingConfirmTextScenario,
  replaceNamedProcedureScenario,
  replaceProcedureScenario,
  replaceRebookScenario,
  rescheduleScenario,
} from "./booking-write.js";
import {
  faqCatalogCloseScenario,
  faqCatalogScenario,
  faqChooseOtherScenario,
  faqFamilyFreeTextScenario,
  faqHoursScenario,
  faqPriceScenario,
  offerPriceScenario,
} from "./faq.js";
import { identityScenario } from "./identity.js";
import {
  faqPriceUahScenario,
  faqPriceUahUnavailableScenario,
  offerPriceUahScenario,
  offerPriceUahUnavailableScenario,
} from "./pricing-uah.js";
import { reminderWebhookScenario } from "./reminder-webhook.js";
import { supervisorMenuScenario } from "./supervisor-menu.js";

export const ALL_SCENARIOS: SmokeScenario[] = [
  bootstrapScenario,
  faqHoursScenario,
  faqCatalogScenario,
  faqCatalogCloseScenario,
  faqPriceScenario,
  faqChooseOtherScenario,
  faqFamilyFreeTextScenario,
  offerPriceScenario,
  faqPriceUahScenario,
  faqPriceUahUnavailableScenario,
  offerPriceUahScenario,
  offerPriceUahUnavailableScenario,
  supervisorMenuScenario,
  identityScenario,
  bookingFreeTextTypedSlotScenario,
  bookDeclineScenario,
  bookNewContactScenario,
  contactLinkScenario,
  bookProcedureScenario,
  pendingConfirmTextScenario,
  doubleBookGuardScenario,
  replaceRebookScenario,
  replaceProcedureScenario,
  replaceNamedProcedureScenario,
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

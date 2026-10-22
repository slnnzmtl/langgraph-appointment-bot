/**
 * Idle FAQ unique-catalog highlight helpers (ingress + prepare).
 * Keeps supervisor off agent-loop prepare modules.
 */

import type { ServicesContext } from "../tools/service-tools.js";
import type { UnderstoodBookingTurn } from "./booking-domain/turn.js";
import type { InteractionChoice, PendingInteraction } from "./booking-session.js";
import type { ReceptionistRoute } from "./receptionist-route.js";

export type FaqHighlightedService = {
  serviceId: string;
  serviceName?: string;
};

/** FAQ-owned single-chip highlight (informational until explicit book). */
export const faqHighlightChoice = (
  serviceId: string,
  serviceName?: string,
): InteractionChoice => ({
  id: serviceId,
  label: (serviceName ?? serviceId).trim() || serviceId,
  serviceIds: [serviceId],
});

/** Allowlisted single CRM id on an idle FAQ catalog interaction, if any. */
export const faqHighlightedService = (
  interaction: PendingInteraction | null | undefined,
): FaqHighlightedService | null => {
  if (interaction?.kind !== "service_candidate" || interaction.owner !== "faq") {
    return null;
  }
  if (interaction.choices.length !== 1) {
    return null;
  }
  const choice = interaction.choices[0]!;
  const remaining =
    choice.serviceIds != null && choice.serviceIds.length > 0
      ? choice.serviceIds
      : [choice.id];
  if (remaining.length !== 1) {
    return null;
  }
  const serviceId = remaining[0]!;
  const label = (choice.displayLabel ?? choice.label).trim();
  return {
    serviceId,
    ...(label.length > 0 ? { serviceName: label } : {}),
  };
};

/**
 * Rewrite book_highlighted → catalog_service when the highlighted id is on the
 * current allowlisted list; otherwise stay FAQ with serviceIntent stripped.
 */
export const promoteBookHighlightedRoute = (
  patch: UnderstoodBookingTurn,
  highlighted: FaqHighlightedService | null,
  servicesList: ServicesContext["list"] | readonly ServicesContext["list"][number][],
): ReceptionistRoute | null => {
  if (patch.serviceIntent?.kind !== "book_highlighted") {
    return null;
  }
  const row = highlighted != null
    ? servicesList.find((service) => service.id === highlighted.serviceId)
    : undefined;
  if (highlighted != null && row != null) {
    return {
      kind: "booking",
      patch: {
        ...patch,
        serviceIntent: {
          kind: "catalog_service",
          serviceId: row.id,
          ...(row.name != null ? { serviceName: row.name } : {}),
        },
      },
    };
  }
  const { serviceIntent: _stripped, ...rest } = patch;
  return { kind: "faq_capability", patch: rest };
};

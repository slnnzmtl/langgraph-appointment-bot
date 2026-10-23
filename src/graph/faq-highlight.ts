/**
 * Idle FAQ unique-catalog highlight helpers (ingress + prepare).
 * Keeps supervisor off agent-loop prepare modules.
 */

import { DEFAULT_MENU_NO_VISITS } from "../shared/clinic-constants.js";
import type { ServicesContext } from "../tools/service-tools.js";
import type { UnderstoodBookingTurn } from "./booking-domain/turn.js";
import type { InteractionChoice, PendingInteraction } from "./booking/booking-session.js";
import type { ReceptionistRoute } from "./receptionist-route.js";

export type FaqHighlightedService = {
  serviceId: string;
  serviceName?: string;
};

/** Always offer book + browse; never drop «Записатись» when the patient has visits. */
export const FAQ_HIGHLIGHT_REPLY_BUTTONS = [
  DEFAULT_MENU_NO_VISITS[0],
  DEFAULT_MENU_NO_VISITS[1],
] as const;

const FAQ_HIGHLIGHT_BOOK_HINT_UK =
  "Щоб записатися на цю послугу, натисніть «Записатись».";

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
 * Informational card for a unique FAQ highlight — not a one-item picker.
 * Optional CRM description from the current catalog list.
 */
export const renderFaqHighlightReply = (
  highlighted: FaqHighlightedService,
  services: ServicesContext["list"] | readonly ServicesContext["list"][number][] = [],
): string => {
  const row = services.find((service) => service.id === highlighted.serviceId);
  const name = (row?.name ?? highlighted.serviceName ?? highlighted.serviceId).trim()
    || highlighted.serviceId;
  const description = row?.description?.trim();
  const parts = [name];
  if (description != null && description.length > 0) {
    parts.push(description);
  }
  parts.push(FAQ_HIGHLIGHT_BOOK_HINT_UK);
  return parts.join("\n\n");
};

export type BookHighlightedPromotion =
  | { status: "not_requested" }
  | { status: "promoted"; route: ReceptionistRoute }
  /** Fresh non-empty catalog loaded but the highlighted id is not on it. */
  | { status: "stale_highlight" }
  /** No catalog rows to check membership (missing context, not refetched yet). */
  | { status: "highlight_unverified" };

export type ResolveBookHighlightedOptions = {
  /** True when a non-empty services list is available for id lookup. */
  catalogReady: boolean;
};

/**
 * Promote book_highlighted → catalog_service when the id is on the current list.
 * Missing/stale rows must clear the highlight (supervisor FINISH), not reopen FAQ chips.
 */
export const resolveBookHighlightedPromotion = (
  patch: UnderstoodBookingTurn,
  highlighted: FaqHighlightedService | null,
  servicesList: ServicesContext["list"] | readonly ServicesContext["list"][number][],
  options: ResolveBookHighlightedOptions,
): BookHighlightedPromotion => {
  if (patch.serviceIntent?.kind !== "book_highlighted") {
    return { status: "not_requested" };
  }
  const row = highlighted != null
    ? servicesList.find((service) => service.id === highlighted.serviceId)
    : undefined;
  if (highlighted != null && row != null) {
    return {
      status: "promoted",
      route: {
        kind: "booking",
        patch: {
          ...patch,
          serviceIntent: {
            kind: "catalog_service",
            serviceId: row.id,
            ...(row.name != null ? { serviceName: row.name } : {}),
          },
        },
      },
    };
  }
  if (!options.catalogReady) {
    return { status: "highlight_unverified" };
  }
  return { status: "stale_highlight" };
};

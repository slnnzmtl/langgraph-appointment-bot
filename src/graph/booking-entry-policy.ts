import type { BookingDraft, BookingService } from "./booking-draft.js";
import {
  reduceBookingSession,
  type PendingInteraction,
} from "./booking-session.js";
import {
  normalizeCatalogUtterance,
  resolveCatalogFreeText,
  resolveFaqCatalogChoices,
  type CatalogFreeTextResult,
} from "./agent-loop/shared.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "./service-resolution.js";
import type { ServicesContext } from "../tools/service-tools.js";

const catalogRowToBookingService = (
  row: ServicesContext["list"][number],
): BookingService => ({
  id: row.id,
  name: row.name,
  ...(row.duration != null ? { durationMinutes: row.duration } : {}),
  source: "catalog",
});

type BookingSessionSnapshot = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
};

/** Apply resolveCatalogFreeText output to booking session (offer or FAQ chips). */
const applyCatalogFreeTextResolution = async (input: {
  resolved: CatalogFreeTextResult;
  services: ServicesContext["list"];
  utterance: string;
  selectedLabel: string;
  session: BookingSessionSnapshot;
  consultationDeclined?: boolean;
  partitionCandidates?: PartitionServiceCandidates;
}): Promise<ReturnType<typeof reduceBookingSession> | null> => {
  const { resolved } = input;
  if (resolved.kind === "one") {
    return reduceBookingSession(input.session, {
      type: "service_offered",
      service: catalogRowToBookingService(resolved.row),
    });
  }
  if (resolved.kind !== "many") {
    return null;
  }
  const choices = await resolveFaqCatalogChoices({
    services: input.services,
    remainingIds: resolved.ids,
    utterance: input.utterance,
    ...(resolved.groups != null ? { groups: resolved.groups } : {}),
    ...(input.selectedLabel.length > 0 ? { selectedLabel: input.selectedLabel } : {}),
    ...(input.partitionCandidates != null
      ? { partitionCandidates: input.partitionCandidates }
      : {}),
  });
  if (choices.length === 0) {
    return null;
  }
  return reduceBookingSession(input.session, {
    type: "service_candidates_opened",
    utterance: input.utterance,
    owner: "faq",
    ...(input.consultationDeclined === true ? { consultationDeclined: true } : {}),
    choices,
  });
};

/**
 * Shared catalog open for FAQ free text and open-offer switches.
 * `text` is what the matcher sees; `utterance` is stored on the interaction.
 */
export const openCatalogFromFreeText = async (input: {
  text: string;
  services: ServicesContext["list"];
  session: BookingSessionSnapshot;
  utterance?: string;
  selectedLabel?: string;
  consultationDeclined?: boolean;
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
}): Promise<ReturnType<typeof reduceBookingSession> | null> => {
  const resolved = await resolveCatalogFreeText({
    text: input.text,
    rows: input.services,
    ...(input.selectCandidates != null
      ? { selectCandidates: input.selectCandidates }
      : {}),
  });
  return applyCatalogFreeTextResolution({
    resolved,
    services: input.services,
    utterance: input.utterance ?? input.text,
    selectedLabel: input.selectedLabel ?? normalizeCatalogUtterance(input.text),
    session: input.session,
    ...(input.consultationDeclined === true
      ? { consultationDeclined: true }
      : {}),
    ...(input.partitionCandidates != null
      ? { partitionCandidates: input.partitionCandidates }
      : {}),
  });
};

/**
 * Root FAQ catalog after a replacement cancel that has no accepted service
 * and no frozen command to replay. Same transition the tools node used inline.
 */
export const openRootFaqCatalog = async (input: {
  services: ServicesContext["list"];
  bookingDraft: BookingDraft | null;
  partitionCandidates?: PartitionServiceCandidates;
  utterance?: string;
}): Promise<ReturnType<typeof reduceBookingSession> | null> => {
  if (input.services.length === 0) {
    return null;
  }
  const utterance = input.utterance ?? "catalog";
  const choices = await resolveFaqCatalogChoices({
    services: input.services,
    utterance,
    query: FAQ_ROOT_PARTITION_QUERY,
    ...(input.partitionCandidates != null
      ? { partitionCandidates: input.partitionCandidates }
      : {}),
  });
  if (choices.length === 0) {
    return null;
  }
  return reduceBookingSession(
    { bookingDraft: input.bookingDraft, pendingInteraction: null },
    {
      type: "service_candidates_opened",
      utterance,
      owner: "faq",
      consultationDeclined: true,
      choices,
    },
  );
};

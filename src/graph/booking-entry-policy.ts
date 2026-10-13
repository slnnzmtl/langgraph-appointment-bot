import type { BookingDraft, BookingService } from "./booking-draft.js";
import {
  reduceBookingSession,
  type PendingInteraction,
} from "./booking-session.js";
import {
  matchingCatalogRows,
  resolveCatalogFreeText,
  resolveFaqCatalogChoices,
  type CatalogFreeTextResult,
} from "./agent-loop/shared.js";
import {
  FAQ_ROOT_PARTITION_QUERY,
  type PartitionServiceCandidates,
  type SelectServiceCandidates,
} from "./service-resolution.js";
import type { ClinicRoutingDecision, SupervisorIntent } from "./routing.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "./types.js";
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
  selectedLabel?: string;
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
    ...(input.selectedLabel != null && input.selectedLabel.length > 0
      ? { selectedLabel: input.selectedLabel }
      : {}),
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
 * `selectedLabel` is only a tapped CRM chip path — never a patient sentence.
 */
export const openCatalogFromFreeText = async (input: {
  text: string;
  services: ServicesContext["list"];
  session: BookingSessionSnapshot;
  utterance?: string;
  selectedLabel?: string;
  consultationDeclined?: boolean;
  /** named_procedure only — strip trailing ? for matching; rematch omits this. */
  allowTerminalQuestion?: boolean;
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
}): Promise<ReturnType<typeof reduceBookingSession> | null> => {
  const resolved = await resolveCatalogFreeText({
    text: input.text,
    rows: input.services,
    ...(input.allowTerminalQuestion === true
      ? { allowTerminalQuestion: true }
      : {}),
    ...(input.selectCandidates != null
      ? { selectCandidates: input.selectCandidates }
      : {}),
  });
  return applyCatalogFreeTextResolution({
    resolved,
    services: input.services,
    utterance: input.utterance ?? input.text,
    ...(input.selectedLabel != null && input.selectedLabel.length > 0
      ? { selectedLabel: input.selectedLabel }
      : {}),
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
 * Idle FAQ named-procedure book: supervisor intent gates catalog open — no
 * book-prefix regex. Singleton → service_confirm; family → FAQ chips.
 */
export const faqNamedProcedureEntryForTurn = async (input: {
  supervisorIntent: SupervisorIntent | null | undefined;
  patientText: string;
  services: ServicesContext["list"];
  session: BookingSessionSnapshot;
  /** True when browse shortcut or an open FAQ picker already handled this turn. */
  alreadyHandled: boolean;
  partitionCandidates?: PartitionServiceCandidates;
  selectCandidates?: SelectServiceCandidates;
}): Promise<ReturnType<typeof reduceBookingSession> | null> => {
  if (
    input.alreadyHandled
    || input.supervisorIntent !== "named_procedure"
    || input.patientText.trim().length === 0
    || input.services.length === 0
  ) {
    return null;
  }
  return openCatalogFromFreeText({
    text: input.patientText,
    services: input.services,
    session: input.session,
    utterance: input.patientText,
    allowTerminalQuestion: true,
    ...(input.partitionCandidates != null
      ? { partitionCandidates: input.partitionCandidates }
      : {}),
    ...(input.selectCandidates != null
      ? { selectCandidates: input.selectCandidates }
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

/** Post-supervisor routing decision for named vs generic booking. */
export type NamedBookingPolicyResult = {
  decision: ClinicRoutingDecision;
  /** Catalog loaded this turn for CRM evidence (checkpoint when set). */
  servicesContext?: ServicesContext;
  /** Model `book` needed CRM rows but the catalog could not be loaded. */
  catalogUnavailable?: boolean;
};

const stripTerminalQuestion = (text: string): string =>
  text.trim().replace(/[?？]+\s*$/u, "").trim();

/**
 * CRM vocabulary evidence via the shared catalog resolver (terminal `?` allowed).
 * Multi-stem families without a selector still count when lexical rows hit.
 */
export const utteranceHasCatalogCrmEvidence = async (input: {
  text: string;
  services: ServicesContext["list"];
  selectCandidates?: SelectServiceCandidates;
}): Promise<boolean> => {
  if (input.services.length === 0 || input.text.trim().length === 0) {
    return false;
  }
  const resolved = await resolveCatalogFreeText({
    text: input.text,
    rows: input.services,
    allowTerminalQuestion: true,
    ...(input.selectCandidates != null
      ? { selectCandidates: input.selectCandidates }
      : {}),
  });
  if (resolved.kind !== "none") {
    return true;
  }
  return matchingCatalogRows(stripTerminalQuestion(input.text), input.services).length > 0;
};

/**
 * Refine the supervisor LLM decision with CRM catalog evidence.
 * Does not guess a service id — only next agent + intent for FAQ prepare / REPLACE.
 */
export const refineSupervisorNamedBooking = async (input: {
  decision: ClinicRoutingDecision;
  patientText: string;
  hasVisit: boolean;
  services: ServicesContext["list"] | null | undefined;
  loadServices?: () => Promise<ServicesContext | null>;
  selectCandidates?: SelectServiceCandidates;
}): Promise<NamedBookingPolicyResult> => {
  const { decision } = input;
  const intent = decision.intent;

  if (intent === "faq") {
    return { decision };
  }

  if (intent === "named_procedure") {
    if (input.hasVisit) {
      return {
        decision: {
          ...decision,
          next: BOOKING_AGENT_ID,
          intent: "book",
        },
      };
    }
    return {
      decision: {
        ...decision,
        next: FAQ_AGENT_ID,
        intent: "named_procedure",
      },
    };
  }

  if (intent !== "book") {
    return { decision };
  }

  let servicesList = input.services ?? [];
  let servicesContext: ServicesContext | undefined;
  if (servicesList.length === 0 && input.loadServices != null) {
    const loaded = await input.loadServices().catch(() => null);
    if (loaded != null && loaded.list.length > 0) {
      servicesContext = loaded;
      servicesList = loaded.list;
    } else {
      return { decision, catalogUnavailable: true };
    }
  }
  if (servicesList.length === 0) {
    return {
      decision,
      ...(servicesContext != null ? { servicesContext } : {}),
      catalogUnavailable: true,
    };
  }

  const hasCrm = await utteranceHasCatalogCrmEvidence({
    text: input.patientText,
    services: servicesList,
    ...(input.selectCandidates != null
      ? { selectCandidates: input.selectCandidates }
      : {}),
  });
  if (!hasCrm) {
    return {
      decision,
      ...(servicesContext != null ? { servicesContext } : {}),
    };
  }

  if (input.hasVisit) {
    return {
      decision: {
        ...decision,
        next: BOOKING_AGENT_ID,
        intent: "book",
      },
      ...(servicesContext != null ? { servicesContext } : {}),
    };
  }

  return {
    decision: {
      ...decision,
      next: FAQ_AGENT_ID,
      intent: "named_procedure",
    },
    ...(servicesContext != null ? { servicesContext } : {}),
  };
};

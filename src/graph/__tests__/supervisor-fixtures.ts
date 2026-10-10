import { vi } from "vitest";

import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import type { ClinicState } from "../state.js";
import type { ClinicAgentDefinition } from "../types.js";

export const createCachedGeminiModel = vi.fn(
  (_apiKey: string, _model: string, handle: { cacheName: string }) => ({
    kind: "cached",
    cacheName: handle.cacheName,
  }),
);

export const isCachedContentNotFoundError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /CachedContent not found/i.test(message);
});

vi.mock("@personal-assistant/llm-gemini", () => ({
  createCachedGeminiModel: (...args: unknown[]) =>
    (createCachedGeminiModel as (...a: unknown[]) => unknown)(...args),
  isCachedContentNotFoundError: (error: unknown) => isCachedContentNotFoundError(error),
}));

export const {
  createClinicSupervisorNode,
  isVisitStatusSignal,
  isPrefetchExpired,
  PREFETCH_TTL_MS,
  shouldContinueInBooking,
  shouldContinueInFaq,
  shouldRouteProcedureBrowseToFaq,
  shouldStayInFaqCatalog,
  stickyContinueAgentId,
} = await import("../supervisor.js");

export const supervisorState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  availabilityCursor: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
  selectedAvailabilityDate: null,
  bookingDraft: null,
  bookingSchemaVersion: 1,
  pendingInteraction: null,
  noteOrchQueued: false,
  serviceChangeNotice: null,
  pendingCancellationPurpose: null,
  ...overrides,
});

export const agents: ClinicAgentDefinition[] = [
  {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "faq",
    maxSteps: 4,
  },
  {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "booking",
    maxSteps: 10,
  },
];

export const serviceConfirmPending = {
  kind: "service_confirm" as const,
  service: {
    id: CONSULTATION_SERVICE_ID,
    name: "Консультація",
    source: "catalog" as const,
  },
  choices: [
    { id: "accept", label: "Так" },
    { id: "choose_other", label: "Обрати іншу процедуру" },
  ],
};

export const dateSelectPending = {
  kind: "date_select" as const,
  snapshot: {
    snapshotId: "sticky-test",
    queryKind: "nearest" as const,
    days: [
      {
        date: "2026-08-25",
        displayLabel: "25 серпня",
        slotSummaries: ["11:00"],
        slots: [],
      },
    ],
  },
  choices: [
    { id: "2026-08-25", label: "25 серпня" },
    { id: "2026-09-03", label: "3 вересня" },
    { id: "other_date", label: "Інша дата" },
  ],
};

export const faqCatalogPending = (labels: string[]) => ({
  kind: "service_candidate" as const,
  owner: "faq" as const,
  utterance: "catalog",
  choices: labels.map((label, index) => ({
    id: `g${index}`,
    label,
    serviceIds: [`svc-${index}`],
  })),
});

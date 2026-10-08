/**
 * Deterministic smoke: consultation-about-procedure → «Змінити послугу» resolves to
 * «Консультація», not a botox brand partition. No LLM or MCP catalog fetch.
 */
import {
  SERVICE_OR_NOTE_SWITCH_LABEL_UK,
  serviceChangedNoticeUk,
} from "../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../graph/booking-draft.js";
import {
  defaultServiceOrNoteChoices,
  orchestrateBookingNoteTurn,
} from "../graph/booking-note-orchestrator.js";
import type { ClassifyNoteTurn } from "../graph/booking-note-turn.js";
import {
  openVisitNoteInteraction,
  reduceBookingSession,
} from "../graph/booking-session.js";
import {
  resolveServiceChange,
  type ServiceCatalogRow,
} from "../graph/service-resolution.js";

const SMOKE_CATALOG: ServiceCatalogRow[] = [
  { id: "svc-consult", name: "Консультація", duration: 30 },
  { id: "svc-botox-disport", name: "Ботулінотерапія Botox, Disport FULL FACE+шия", duration: 45 },
  { id: "svc-botox-nabota", name: "Ботулінотерапія Nabota FULL FACE", duration: 45 },
];

const botoxFullFaceDraft = () => {
  const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: {
      id: "svc-botox-disport",
      name: "Ботулінотерапія Botox, Disport FULL FACE+шия",
      source: "catalog",
    },
    accepted: true,
  });
  const dated = reduceBookingDraft(accepted, {
    type: "date_selected",
    date: "2026-10-19",
  });
  const slotted = reduceBookingDraft(dated, {
    type: "slot_selected",
    slot: {
      dateStart: "2026-10-19T11:30:00",
      dateEnd: "2026-10-19T12:00:00",
      label: "11:30",
    },
  })!;
  return reduceBookingDraft(slotted, {
    type: "note_status",
    status: "awaiting",
  })!;
};

export const runConsultationSwitchSmoke = async (): Promise<void> => {
  const patientText = "нужна консультация по ботоксу";
  const draft = botoxFullFaceDraft();

  const classifyClarify: ClassifyNoteTurn = async () => ({
    kind: "service_or_note_clarification_required",
    query: "Консультація",
  });

  const clarified = await orchestrateBookingNoteTurn({
    patientText,
    bookingDraft: draft,
    pendingInteraction: openVisitNoteInteraction(),
    currentServiceName: "Ботулінотерапія Botox, Disport FULL FACE+шия",
    classify: classifyClarify,
    resolveServiceChange: async () => {
      throw new Error("resolve must not run on clarification");
    },
  });

  if (clarified.goto !== "interaction_render") {
    throw new Error(
      `Expected interaction_render after consultation note, got ${clarified.goto}`,
    );
  }
  if (clarified.pendingInteraction?.kind !== "service_or_note") {
    throw new Error(
      `Expected service_or_note interaction, got ${clarified.pendingInteraction?.kind ?? "null"}`,
    );
  }

  const selectCandidates = async (): Promise<never> => {
    throw new Error(
      "selectCandidates must not run when query exact-matches Консультація",
    );
  };

  const switched = await orchestrateBookingNoteTurn({
    patientText: SERVICE_OR_NOTE_SWITCH_LABEL_UK,
    bookingDraft: clarified.bookingDraft,
    pendingInteraction: {
      ...clarified.pendingInteraction!,
      choices: defaultServiceOrNoteChoices(),
    },
    classify: async () => {
      throw new Error("classifier must not run on switch_service chip");
    },
    resolveServiceChange: (effect) =>
      resolveServiceChange(effect, {
        fetchCatalog: async () => ({ ok: true, rows: SMOKE_CATALOG }),
        selectCandidates,
      }),
  });

  if (switched.goto !== "command_prepare") {
    throw new Error(
      `Expected command_prepare after switch to consultation, got ${switched.goto}`,
    );
  }
  if (switched.pendingInteraction != null) {
    throw new Error("Expected pendingInteraction cleared after service_changed");
  }
  if (switched.bookingDraft?.serviceAcceptance?.service.id !== "svc-consult") {
    throw new Error(
      `Expected svc-consult, got ${switched.bookingDraft?.serviceAcceptance?.service.id ?? "none"}`,
    );
  }
  if (switched.bookingDraft?.selectedSlot != null) {
    throw new Error("Expected slot cleared after service change");
  }
  if (switched.bookingDraft?.selectedDate != null) {
    throw new Error("Expected date cleared after service change");
  }
  const notice = switched.serviceChangeNotice;
  const expectedNotice = serviceChangedNoticeUk("Консультація");
  if (notice !== expectedNotice) {
    throw new Error(`Expected service change notice "${expectedNotice}", got "${notice ?? ""}"`);
  }
  if (switched.bookingDraft?.note.status !== "unasked") {
    throw new Error(
      `Expected note reset to unasked after different-id switch, got ${switched.bookingDraft?.note.status}`,
    );
  }

  const dated = reduceBookingSession(
    { bookingDraft: switched.bookingDraft, pendingInteraction: null },
    { type: "date_selected", date: "2026-10-22" },
  );
  const slotted = reduceBookingSession(dated, {
    type: "slot_selected",
    slot: {
      dateStart: "2026-10-22T11:00:00",
      dateEnd: "2026-10-22T11:30:00",
      label: "11:00",
    },
  });
  if (slotted.pendingInteraction?.kind !== "visit_note") {
    throw new Error(
      `Expected visit_note after fresh slot, got ${slotted.pendingInteraction?.kind ?? "null"}`,
    );
  }
  if (slotted.bookingDraft?.note.status !== "awaiting") {
    throw new Error(
      `Expected note awaiting after fresh slot, got ${slotted.bookingDraft?.note.status}`,
    );
  }

  console.log("✓ Consultation switch smoke (note → Змінити послугу → Консультація)");
};

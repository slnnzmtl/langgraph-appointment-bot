import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command, Overwrite } from "@langchain/langgraph";

import {
  BOOKING_NOTE_QUESTION_UK,
  RETURN_TO_BOOKING_LABEL_UK,
  SERVICE_OR_NOTE_KEEP_LABEL_UK,
  SERVICE_OR_NOTE_SWITCH_LABEL_UK,
} from "../shared/clinic-constants.js";
import { extractMessageTextContent } from "../shared/message-content.js";
import type { BookingDraft, BookingService } from "./booking-draft.js";
import {
  interpretNoteTurn,
  sessionEventFromClassification,
  type ClassifyNoteTurn,
  type NoteTurnScheduleMatch,
} from "./booking-note-turn.js";
import {
  isBookingOwnedInteraction,
  openVisitNoteInteraction,
  reduceBookingSession,
  type BookingSessionEffect,
  type PendingInteraction,
  type ResolveServiceEffect,
} from "./pending-interaction.js";
import type { ClinicState } from "./state.js";

export type NoteOrchestratorGoto =
  | "booking_llm"
  | "command_prepare"
  | "interaction_render"
  | "faq_prepare";

export type ServiceResolutionResult =
  | {
      type: "service_changed";
      service: BookingService;
      accepted: boolean;
      noteCandidate?: string;
    }
  | {
      type: "service_candidates_opened";
      utterance: string;
      query?: string;
      noteCandidate?: string;
      choices: Array<{ id: string; label: string }>;
    }
  | { type: "service_unresolved" };

export type ResolveServiceChange = (
  effect: ResolveServiceEffect,
) => Promise<ServiceResolutionResult>;

export type OrchestrateBookingNoteTurnInput = {
  patientText: string;
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
  currentServiceName?: string;
  matchSchedule?: (text: string) => NoteTurnScheduleMatch;
  classify: ClassifyNoteTurn;
  resolveServiceChange: ResolveServiceChange;
};

export type OrchestrateBookingNoteTurnResult = {
  bookingDraft: BookingDraft | null;
  pendingInteraction: PendingInteraction | null;
  clearAvailability: boolean;
  goto: NoteOrchestratorGoto;
};

export const defaultServiceOrNoteChoices = (
  currentServiceName?: string,
): Array<{ id: string; label: string }> => {
  const keepLabel = currentServiceName != null && currentServiceName.trim().length > 0
    ? `${SERVICE_OR_NOTE_KEEP_LABEL_UK} (${currentServiceName})`
    : SERVICE_OR_NOTE_KEEP_LABEL_UK;
  return [
    { id: "keep_service", label: keepLabel },
    { id: "switch_service", label: SERVICE_OR_NOTE_SWITCH_LABEL_UK },
  ];
};

const applyEffect = async (
  state: {
    bookingDraft: BookingDraft | null;
    pendingInteraction: PendingInteraction | null;
  },
  effect: BookingSessionEffect | null,
  resolveServiceChange: ResolveServiceChange,
): Promise<OrchestrateBookingNoteTurnResult> => {
  if (effect == null) {
    return destinationForState(state, false);
  }
  if (effect.type === "apply_service_choice") {
    const resolved = await resolveServiceChange({
      type: "resolve_service",
      utterance: effect.label,
      query: effect.serviceId,
      ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
    });
    // Prefer applying the known CRM id directly when the resolver confirms it.
    if (resolved.type === "service_changed") {
      const noteCandidate = resolved.noteCandidate ?? effect.noteCandidate;
      const second = reduceBookingSession(state, {
        type: "service_changed",
        service: resolved.service,
        accepted: resolved.accepted,
        ...(noteCandidate != null ? { noteCandidate } : {}),
      });
      return destinationForState(second, second.clearAvailability);
    }
    return applyResolution(state, resolved);
  }

  const resolved = await resolveServiceChange(effect);
  return applyResolution(state, resolved);
};

const applyResolution = (
  state: {
    bookingDraft: BookingDraft | null;
    pendingInteraction: PendingInteraction | null;
  },
  resolved: ServiceResolutionResult,
): OrchestrateBookingNoteTurnResult => {
  if (resolved.type === "service_changed") {
    const second = reduceBookingSession(state, {
      type: "service_changed",
      service: resolved.service,
      accepted: resolved.accepted,
      ...(resolved.noteCandidate != null ? { noteCandidate: resolved.noteCandidate } : {}),
    });
    return destinationForState(second, second.clearAvailability);
  }
  if (resolved.type === "service_candidates_opened") {
    const second = reduceBookingSession(state, {
      type: "service_candidates_opened",
      utterance: resolved.utterance,
      ...(resolved.query != null ? { query: resolved.query } : {}),
      ...(resolved.noteCandidate != null ? { noteCandidate: resolved.noteCandidate } : {}),
      choices: resolved.choices,
    });
    return destinationForState(second, false);
  }
  const second = reduceBookingSession(state, {
    type: "service_unresolved",
    returnLabel: RETURN_TO_BOOKING_LABEL_UK,
  });
  return {
    bookingDraft: second.bookingDraft,
    pendingInteraction: second.pendingInteraction,
    clearAvailability: false,
    goto: "faq_prepare",
  };
};

const destinationForState = (
  state: {
    bookingDraft: BookingDraft | null;
    pendingInteraction: PendingInteraction | null;
  },
  clearAvailability: boolean,
): OrchestrateBookingNoteTurnResult => {
  const interaction = state.pendingInteraction;
  if (interaction != null && isBookingOwnedInteraction(interaction)) {
    const noteDone = state.bookingDraft?.note.status === "answered"
      || state.bookingDraft?.note.status === "skipped";
    if (interaction.kind === "visit_note" && noteDone) {
      return {
        bookingDraft: state.bookingDraft,
        pendingInteraction: null,
        clearAvailability,
        goto: "command_prepare",
      };
    }
    if (
      interaction.kind === "service_or_note"
      || interaction.kind === "service_candidate"
      || interaction.kind === "visit_note"
    ) {
      return {
        bookingDraft: state.bookingDraft,
        pendingInteraction: interaction,
        clearAvailability,
        goto: "interaction_render",
      };
    }
  }
  const noteDone = state.bookingDraft?.note.status === "answered"
    || state.bookingDraft?.note.status === "skipped";
  const hasSlot = state.bookingDraft?.selectedSlot != null;
  if (noteDone && hasSlot && !clearAvailability) {
    return {
      bookingDraft: state.bookingDraft,
      pendingInteraction: state.pendingInteraction,
      clearAvailability,
      goto: "command_prepare",
    };
  }
  return {
    bookingDraft: state.bookingDraft,
    pendingInteraction: state.pendingInteraction,
    clearAvailability,
    goto: "booking_llm",
  };
};

/**
 * Interpret once → pure session reduction → optional resolve → pure reduction → goto.
 * CRM and model calls stay outside reduceBookingSession.
 */
export const orchestrateBookingNoteTurn = async (
  input: OrchestrateBookingNoteTurnInput,
): Promise<OrchestrateBookingNoteTurnResult> => {
  const originalPatientText = input.patientText.trim();
  const interpreted = await interpretNoteTurn({
    patientText: originalPatientText,
    pendingInteraction: input.pendingInteraction,
    ...(input.matchSchedule != null ? { matchSchedule: input.matchSchedule } : {}),
    ...(input.currentServiceName != null
      ? { currentServiceName: input.currentServiceName }
      : {}),
    classify: input.classify,
  });

  let sessionEvent;
  if (interpreted.source === "trusted") {
    sessionEvent = interpreted.sessionEvent;
  } else {
    const mapped = sessionEventFromClassification(
      interpreted.classification,
      originalPatientText,
    );
    if (mapped.type === "unresolved") {
      const preserved = input.pendingInteraction != null
        ? input.pendingInteraction
        : openVisitNoteInteraction();
      return {
        bookingDraft: input.bookingDraft,
        pendingInteraction: preserved,
        clearAvailability: false,
        goto: "interaction_render",
      };
    }
    if (mapped.type === "service_or_note_opened") {
      sessionEvent = {
        ...mapped,
        choices: mapped.choices.length > 0
          ? mapped.choices
          : defaultServiceOrNoteChoices(input.currentServiceName),
      };
    } else {
      sessionEvent = mapped;
    }
  }

  const first = reduceBookingSession(
    {
      bookingDraft: input.bookingDraft,
      pendingInteraction: input.pendingInteraction,
    },
    sessionEvent,
  );

  if (first.effect != null) {
    return applyEffect(first, first.effect, input.resolveServiceChange);
  }

  return destinationForState(first, first.clearAvailability);
};

export const bookingTurnNeedsNoteOrchestrator = (state: {
  bookingDraft?: BookingDraft | null;
  pendingInteraction?: PendingInteraction | null;
}): boolean => {
  if (isBookingOwnedInteraction(state.pendingInteraction)) {
    return true;
  }
  const draft = state.bookingDraft;
  if (draft == null || draft.mode === "reschedule") {
    return false;
  }
  return draft.phase === "note"
    || (draft.selectedSlot != null
      && (draft.note.status === "awaiting" || draft.note.status === "unasked"));
};

const clarificationBody = (interaction: PendingInteraction): string => {
  if (interaction.kind === "visit_note") {
    return BOOKING_NOTE_QUESTION_UK;
  }
  if (interaction.kind === "service_or_note") {
    const service = interaction.currentService.name ?? interaction.currentService.id;
    return (
      `Ви обрали «${service}». Ваше повідомлення також може означати зміну послуги.\n\n`
      + "Оберіть, будь ласка:"
    );
  }
  return "Оберіть, будь ласка, послугу зі списку:";
};

/** Build a fresh AIMessage from the open interaction. Never reuse stale agentMessages. */
export const renderBookingInteractionMessage = (
  interaction: PendingInteraction,
  _options?: { staleMessages?: BaseMessage[] },
): AIMessage =>
  new AIMessage(clarificationBody(interaction));

export const replyButtonsForInteraction = (
  interaction: PendingInteraction,
): string[] => interaction.choices.map((choice) => choice.label);

export type BookingNoteOrchestratorDeps = {
  classify: ClassifyNoteTurn;
  resolveServiceChange: ResolveServiceChange;
  /** Optional schedule grounding against the live checkpoint (injected to avoid cycles). */
  matchScheduleFromState?: (
    text: string,
    state: ClinicState,
  ) => NoteTurnScheduleMatch;
  nodes: {
    bookingLlm: string;
    commandPrepare: string;
    interactionRender: string;
    faqPrepare: string;
  };
};

export const noteOrchestratorNodeName = (agentId: string): string =>
  `${agentId}__note_orch`;

export const interactionRenderNodeName = (agentId: string): string =>
  `${agentId}__interaction_render`;

/** Graph node: interpret → reduce → optional resolve → reduce → Command.goto. */
export const createBookingNoteOrchestratorNode = (
  deps: BookingNoteOrchestratorDeps,
) => async (state: ClinicState): Promise<Command> => {
  const lastHuman = [...(state.messages ?? [])]
    .reverse()
    .find((message) => message instanceof HumanMessage);
  const patientText = lastHuman
    ? extractMessageTextContent(lastHuman.content).trim()
    : "";
  const currentServiceName = state.bookingDraft?.serviceAcceptance?.service.name;

  const result = await orchestrateBookingNoteTurn({
    patientText,
    bookingDraft: state.bookingDraft ?? null,
    pendingInteraction: state.pendingInteraction ?? null,
    ...(currentServiceName != null ? { currentServiceName } : {}),
    ...(deps.matchScheduleFromState != null
      ? { matchSchedule: (text) => deps.matchScheduleFromState!(text, state) }
      : {}),
    classify: deps.classify,
    resolveServiceChange: deps.resolveServiceChange,
  });

  const goto = result.goto === "booking_llm"
    ? deps.nodes.bookingLlm
    : result.goto === "command_prepare"
      ? deps.nodes.commandPrepare
      : result.goto === "faq_prepare"
        ? deps.nodes.faqPrepare
        : deps.nodes.interactionRender;

  return new Command({
    update: {
      bookingDraft: result.bookingDraft,
      pendingInteraction: result.pendingInteraction,
      noteOrchQueued: false,
      ...(result.clearAvailability
        ? { availabilityContext: null, availabilityCursor: null }
        : {}),
    },
    goto,
  });
};

/** Graph node: write a fresh AIMessage then continue to finalize. */
export const createBookingInteractionRenderNode = (
  agent: { id: string; name: string },
) => (state: ClinicState) => {
  const interaction = state.pendingInteraction != null
    && isBookingOwnedInteraction(state.pendingInteraction)
    ? state.pendingInteraction
    : openVisitNoteInteraction();
  const message = renderBookingInteractionMessage(interaction);
  const replyText = String(message.content);
  const replyButtons = replyButtonsForInteraction(interaction);
  return {
    agentMessages: new Overwrite([message]),
    lastHandoff: {
      agentId: agent.id,
      agentName: agent.name,
      status: "ok" as const,
      replyText,
      replyButtons,
    },
  };
};

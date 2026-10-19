import type {
  BookingDraft,
  BookingPhase,
  PendingBookingCommand,
  PhoneLookupEvidence,
  ReplacementState,
  ServiceAcceptance,
} from "./booking-draft.js";
import type { PendingInteraction } from "./booking-session.js";
import type { SelectedBookingSlot } from "./types.js";
import { nextBookingRequirement } from "./booking-domain/requirement.js";
import {
  BOOKING_SESSION_SCHEMA_VERSION,
  type BookingSessionV2,
  type FrozenMutationCommand,
  type PendingDecision,
  type SlotAvailabilityEvidence,
  type SlotFacts,
  type SlotProvenance,
} from "./booking-domain/session.js";

const toFrozenCommand = (
  command: PendingBookingCommand | null | undefined,
): FrozenMutationCommand | null => {
  if (command == null) {
    return null;
  }
  return {
    action: command.action,
    payload: { ...command.payload },
  };
};

const toPendingCommand = (
  command: FrozenMutationCommand | null,
): PendingBookingCommand | null => {
  if (command == null) {
    return null;
  }
  return {
    action: command.action,
    payload: { ...command.payload },
  };
};

export const slotFactsFromSelected = (
  slot: SelectedBookingSlot | null | undefined,
  provenance: SlotProvenance,
  evidence?: SlotAvailabilityEvidence | null,
): SlotFacts | null => {
  if (slot == null) {
    return null;
  }
  return {
    ...(slot.slotId != null ? { slotId: slot.slotId } : {}),
    dateStart: slot.dateStart,
    dateEnd: slot.dateEnd,
    label: slot.label,
    provenance,
    ...(evidence != null ? { evidence } : {}),
  };
};

/** Missing provenance must never become availability_tool. */
export const resolveSlotProvenanceFromDraft = (
  draft: Pick<BookingDraft, "selectedSlot" | "slotProvenance" | "slotEvidence">,
): SlotProvenance => {
  if (draft.selectedSlot == null) {
    return "none";
  }
  if (draft.slotProvenance === "availability_tool") {
    const snapshotId = draft.slotEvidence?.snapshotId?.trim();
    // Claimed tool provenance without evidence is untrusted.
    return snapshotId != null && snapshotId.length > 0
      ? "availability_tool"
      : "unverified_legacy";
  }
  if (draft.slotProvenance === "unverified_legacy" || draft.slotProvenance === "none") {
    return draft.slotProvenance;
  }
  // Missing / unknown → fail closed.
  return "unverified_legacy";
};

export const selectedFromSlotFacts = (
  slot: SlotFacts | null,
): SelectedBookingSlot | null => {
  if (slot == null) {
    return null;
  }
  return {
    ...(slot.slotId != null ? { slotId: slot.slotId } : {}),
    dateStart: slot.dateStart,
    dateEnd: slot.dateEnd,
    label: slot.label,
  };
};

/** Map irreducible pendingInteraction kinds onto PendingDecision. */
export const pendingDecisionFromInteraction = (
  interaction: PendingInteraction | null | undefined,
  draft: BookingDraft | null | undefined,
): PendingDecision | null => {
  if (interaction == null) {
    return null;
  }
  switch (interaction.kind) {
    case "service_candidate":
      return {
        kind: "service_candidate",
        utterance: interaction.utterance,
        ...(interaction.query != null ? { query: interaction.query } : {}),
      };
    case "visit_select":
      return {
        kind: "visit_select",
        stage: interaction.stage,
        ...(interaction.action != null ? { action: interaction.action } : {}),
      };
    case "service_or_note":
      return {
        kind: "service_or_note",
        noteCandidate: interaction.noteCandidate,
        currentServiceId: interaction.currentService.id,
      };
    case "mutation_confirm": {
      const effectId =
        typeof draft?.pendingCommand?.payload?.effectId === "string"
          ? draft.pendingCommand.payload.effectId
          : `legacy_mutation_${draft?.version ?? 0}`;
      return {
        kind: "mutation_confirm",
        action: interaction.action,
        effectId,
      };
    }
    default:
      // Ordinary DATE/TIME/contact/note/catalog cards are projections only.
      return null;
  }
};

/**
 * Build a canonical session from today's draft (+ optional interaction).
 * Missing provenance fails closed to unverified_legacy — never invents
 * availability_tool trust.
 */
export const bookingDraftToSession = (
  draft: BookingDraft,
  interaction?: PendingInteraction | null,
): BookingSessionV2 => {
  const provenance = resolveSlotProvenanceFromDraft(draft);
  const evidence =
    provenance === "availability_tool" ? (draft.slotEvidence ?? null) : null;
  const pendingDecision =
    draft.pendingDecision
    ?? pendingDecisionFromInteraction(interaction, draft);
  const contactDetails = draft.contactDetails ?? null;
  return {
    schemaVersion: BOOKING_SESSION_SCHEMA_VERSION,
    revision: draft.version,
    mode: draft.mode,
    serviceAcceptance: draft.serviceAcceptance as BookingSessionV2["serviceAcceptance"],
    selectedDate: draft.selectedDate,
    selectedSlot: slotFactsFromSelected(draft.selectedSlot, provenance, evidence),
    requestedTime: draft.requestedTime,
    note: draft.note,
    contact: {
      contactId: draft.contactId,
      ...(contactDetails?.phoneNumber != null
        ? { phoneNumber: contactDetails.phoneNumber }
        : {}),
      ...(contactDetails?.firstName != null ? { firstName: contactDetails.firstName } : {}),
      ...(contactDetails?.lastName != null ? { lastName: contactDetails.lastName } : {}),
      phoneLookup: draft.phoneLookupEvidence ?? null,
    },
    rescheduleTarget: draft.rescheduleTarget ?? null,
    replacement: draft.replacement
      ? {
          meeting: draft.replacement.meeting,
          status: draft.replacement.status,
          ...(draft.replacement.originalCommand != null
            ? { originalCommand: toFrozenCommand(draft.replacement.originalCommand) }
            : {}),
        }
      : null,
    pendingDecision,
    pendingCommand: toFrozenCommand(draft.pendingCommand),
    pendingEffect: null,
  };
};

export const sessionToBookingDraft = (session: BookingSessionV2): BookingDraft => {
  const phase = nextBookingRequirement(session) as BookingPhase;
  const contactDetails =
    session.contact.phoneNumber != null
    || session.contact.firstName != null
    || session.contact.lastName != null
      ? {
          ...(session.contact.phoneNumber != null
            ? { phoneNumber: session.contact.phoneNumber }
            : {}),
          ...(session.contact.firstName != null
            ? { firstName: session.contact.firstName }
            : {}),
          ...(session.contact.lastName != null
            ? { lastName: session.contact.lastName }
            : {}),
        }
      : null;
  const phoneLookup = session.contact.phoneLookup as PhoneLookupEvidence | null;
  const replacement: ReplacementState | null = (() => {
    if (session.replacement == null) {
      return null;
    }
    const original = toPendingCommand(session.replacement.originalCommand ?? null);
    if (original != null) {
      return {
        meeting: session.replacement.meeting,
        status: session.replacement.status,
        originalCommand: original,
      };
    }
    return {
      meeting: session.replacement.meeting,
      status: session.replacement.status,
    };
  })();
  return {
    version: session.revision,
    mode: session.mode,
    phase,
    serviceAcceptance: session.serviceAcceptance as ServiceAcceptance | null,
    selectedDate: session.selectedDate,
    selectedSlot: selectedFromSlotFacts(session.selectedSlot),
    requestedTime: session.requestedTime,
    note: session.note,
    contactId: session.contact.contactId,
    contactDetails,
    phoneLookupEvidence: phoneLookup,
    pendingCommand: toPendingCommand(session.pendingCommand),
    rescheduleTarget: session.rescheduleTarget,
    replacement,
    pendingDecision: session.pendingDecision,
    slotProvenance: session.selectedSlot?.provenance ?? "none",
    slotEvidence: session.selectedSlot?.evidence ?? null,
  };
};

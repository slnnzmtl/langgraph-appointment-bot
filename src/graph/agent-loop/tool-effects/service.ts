import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";
import {
  bookingOfferLabels,
  inferConversationLocaleFromText,
} from "../../../shared/conversation-locale.js";
import { normalizeListServicesResult } from "../../../tools/service-tools.js";
import { openRootFaqCatalog } from "../../booking-entry-policy.js";
import type { BookingDraft } from "../../booking-draft.js";
import {
  consultationService,
  reduceBookingSession,
} from "../../booking-session.js";
import type { PartitionServiceCandidates } from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  captureServicesFromMessages,
  lastPatientText,
} from "../protocol.js";

type ReplacementCatalogOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  listServicesTool?: StructuredToolInterface;
};

/** Tape-rewrite recovery: open consultation service_confirm. */
export const applyServiceConfirmationRecovery = (
  state: ClinicState,
  update: ClinicStateUpdate,
): void => {
  const labels = bookingOfferLabels(
    inferConversationLocaleFromText(lastPatientText(state)),
  );
  const session = reduceBookingSession(
    {
      bookingDraft: state.bookingDraft ?? null,
      pendingInteraction: state.pendingInteraction ?? null,
    },
    {
      type: "service_offered",
      service: consultationService("catalog"),
      acceptLabel: labels.acceptLabel,
      chooseOtherLabel: labels.chooseOtherLabel,
    },
  );
  update.bookingDraft = session.bookingDraft;
  update.pendingInteraction = session.pendingInteraction;
};

/**
 * Pre-slot REPLACE with no accepted service — open the FAQ catalog guide
 * (same as «Обрати іншу процедуру») instead of guessing consultation.
 */
export const applyReplacementCatalogOpen = async (
  state: ClinicState,
  update: ClinicStateUpdate,
  completed: BookingDraft,
  hadOriginal: boolean,
  options?: ReplacementCatalogOptions,
): Promise<void> => {
  if (
    hadOriginal
    || completed.serviceAcceptance?.status === "accepted"
  ) {
    return;
  }
  const listServicesTool = options?.listServicesTool;
  let services = state.servicesContext?.list ?? [];
  if (services.length === 0 && listServicesTool != null) {
    const loaded = await listServicesTool.invoke({}).catch(() => null);
    const normalized = loaded != null
      ? normalizeListServicesResult(String(loaded))
      : null;
    if (normalized != null && normalized.list.length > 0) {
      update.servicesContext = normalized;
      services = normalized.list;
    }
  }
  if (services.length > 0) {
    const session = await openRootFaqCatalog({
      services,
      bookingDraft: completed,
      ...(options?.partitionCandidates != null
        ? { partitionCandidates: options.partitionCandidates }
        : {}),
    });
    if (session != null) {
      update.bookingDraft = session.bookingDraft;
      update.pendingInteraction = session.pendingInteraction;
    }
  }
};

export const applyCapturedServices = (
  resultMessages: BaseMessage[],
  update: ClinicStateUpdate,
): void => {
  const capturedServices = captureServicesFromMessages(resultMessages);
  if (capturedServices !== undefined) {
    update.servicesContext = capturedServices;
  }
};

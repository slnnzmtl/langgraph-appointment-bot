import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { trackEvent } from "../../analytics/track.js";
import {
  bookingOfferLabels,
  inferConversationLocaleFromText,
} from "../../shared/conversation-locale.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { availabilityCursorFromContext } from "../../tools/availability-tools.js";
import { contactMissingFields, normalizeContactLookupResult } from "../../tools/contact-tools.js";
import { normalizeListServicesResult } from "../../tools/service-tools.js";
import { openRootFaqCatalog } from "../booking-entry-policy.js";
import {
  availabilityMatchesBooking,
  reduceBookingDraft,
  type BookingDraft,
  type PendingBookingCommand,
} from "../booking-draft.js";
import { reconcileRequestedTime } from "../booking-schedule.js";
import {
  closedBookingSessionUpdate,
  consultationService,
  reduceBookingSession,
} from "../booking-session.js";
import { cancelCommandFromStoredPayload } from "../cancel-command.js";
import { classifyPhoneLookupResult } from "../contact-command.js";
import type { PartitionServiceCandidates } from "../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  MEETING_MUTATION_TOOLS,
  alreadyBookedMeetingFromMessages,
  captureAvailabilityFromMessages,
  captureLatestToolContext,
  captureServicesFromMessages,
  classifyMeetingMutationToolMessage,
  crmWriteDirtiesPrefetch,
  lastPatientText,
  meetingMutationClearsAvailability,
  meetingMutationIsHitlDecline,
} from "./protocol.js";
import { type ToolProtocolResult } from "./tools-protocol.js";

export type CreateAgentToolsOptions = {
  partitionCandidates?: PartitionServiceCandidates;
};

export const applyToolEffects = async (
  state: ClinicState,
  protocol: ToolProtocolResult,
  toolResultMessages: BaseMessage[],
  options?: CreateAgentToolsOptions & { listServicesTool?: StructuredToolInterface },
): Promise<ClinicStateUpdate> => {
  if (protocol.stateTapeRewrite != null) {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(protocol.stateTapeRewrite),
    };
    if (protocol.recovery?.type === "service_confirmation_required") {
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
    } else if (protocol.recovery?.type === "contact_field_required") {
      const session = reduceBookingSession(
        {
          bookingDraft: state.bookingDraft ?? null,
          pendingInteraction: state.pendingInteraction ?? null,
        },
        {
          type: "contact_field_required",
          field: protocol.recovery.field,
          ...(protocol.recovery.occupied === true ? { occupied: true } : {}),
        },
      );
      update.pendingInteraction = session.pendingInteraction;
    }
    return update;
  }

  const synthetic = protocol.syntheticMessages;
  const listServicesTool = options?.listServicesTool;
  const agentMessages = state.agentMessages ?? [];
    const resultMessages = [...synthetic, ...toolResultMessages];
    const replacementCancellationResult =
      state.bookingDraft?.replacement?.status === "cancelling"
      && resultMessages.some(
        (message) => message instanceof ToolMessage && message.name === "cancel_meeting",
      );
    const update: ClinicStateUpdate = {
      agentMessages: resultMessages,
      ...(replacementCancellationResult
        ? { pendingCancellationPurpose: "replacement" as const }
        : {}),
    };

    const authorizationFailure = resultMessages.some((message) => {
      if (!(message instanceof ToolMessage) || !MEETING_MUTATION_TOOLS.has(message.name ?? "")) {
        return false;
      }
      return asJsonRecord(extractMessageTextContent(message.content).trim())?.error === "Not authorized";
    });
    if (authorizationFailure) {
      // The contact must be linked before this mutation can be retried. Clear
      // every projection that could reconstruct the rejected command so the
      // next route returns to identity resolution instead of replaying it.
      if (state.bookingDraft) {
        update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
          type: "contact_unresolved",
        });
      }
      update.contactContext = null;
      update.bookingContext = null;
      update.prefetchDirty = true;
    }

    const pendingCommand = resultMessages
      .map((message) => {
        if (!(message instanceof ToolMessage)) {
          return null;
        }
        const record = asJsonRecord(extractMessageTextContent(message.content).trim());
        const draft = asJsonRecord(record?.draft);
        const command = asJsonRecord(draft?.command);
        const payload = asJsonRecord(command?.payload);
        if (
          record?.awaitingConfirmation !== true
          || (command?.action !== "create"
            && command?.action !== "reschedule"
            && command?.action !== "replace"
            && command?.action !== "cancel")
          || payload == null
        ) {
          return null;
        }
        if (command?.action === "cancel") {
          // draft.command.payload is the CRM write, not cancel_meeting args.
          const displayName = typeof draft?.name === "string" ? draft.name : undefined;
          const displayStart = typeof draft?.dateStart === "string" ? draft.dateStart : undefined;
          const displayEnd = typeof draft?.dateEnd === "string" ? draft.dateEnd : undefined;
          return cancelCommandFromStoredPayload(payload, {
            ...(displayName ? { name: displayName } : {}),
            ...(displayStart ? { dateStart: displayStart } : {}),
            ...(displayEnd ? { dateEnd: displayEnd } : {}),
          });
        }
        return {
          action: command.action,
          payload,
        } satisfies PendingBookingCommand;
      })
      .find((command): command is PendingBookingCommand => command != null);
    const commandToPersist = pendingCommand
      && state.bookingDraft?.pendingCommand
      && state.bookingDraft.pendingCommand.action === pendingCommand.action
      ? state.bookingDraft.pendingCommand
      : pendingCommand;
    if (commandToPersist && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "command_prepared",
        command: commandToPersist,
      });
    }

    const conflictMeeting = alreadyBookedMeetingFromMessages(resultMessages);
    if (conflictMeeting && state.bookingDraft) {
      update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
        type: "existing_booking_detected",
        meeting: conflictMeeting,
      });
    }

    const cancelCommitted = resultMessages.some(
      (message) =>
        message instanceof ToolMessage
        && message.name === "cancel_meeting"
        && classifyMeetingMutationToolMessage(message) === "committed",
    );
    const cancelDeclined = resultMessages.some(
      (message) =>
        message instanceof ToolMessage
        && message.name === "cancel_meeting"
        && meetingMutationIsHitlDecline(message),
    );

    if (meetingMutationClearsAvailability(resultMessages)) {
      update.availabilityContext = null;
      update.availabilityCursor = null;
      // REPLACE cancel-and-rebook: keep selectedSlot + note so create_meeting can reuse them.
      // Only skip reset when cancel_meeting is the sole committed mutation this turn.
      const committed = resultMessages.filter(
        (message): message is ToolMessage =>
          message instanceof ToolMessage
          && classifyMeetingMutationToolMessage(message) === "committed",
      );
      const cancelOnlyCommitted =
        committed.length > 0 && committed.every((message) => message.name === "cancel_meeting");
      if (cancelCommitted && state.bookingDraft?.replacement?.status === "cancelling") {
        const hadOriginal =
          state.bookingDraft.replacement.originalCommand?.action === "create"
          || state.bookingDraft.replacement.originalCommand?.action === "reschedule";
        const completed = reduceBookingDraft(state.bookingDraft, {
          type: "cancel_existing_completed",
        });
        update.bookingDraft = completed;
        // HITL card is done; do not leave mutation_confirm stuck for the continue path.
        update.pendingInteraction = null;
        const cancelledId = state.bookingDraft.replacement.meeting.id;
        if (state.bookingContext != null && cancelledId.length > 0) {
          // Prefetch is dirty but not refreshed mid-turn — drop the cancelled
          // visit so the continue LLM/prepare does not re-offer REPLACE.
          update.bookingContext = {
            ...state.bookingContext,
            meetings: state.bookingContext.meetings.filter(
              (meeting) => meeting.id !== cancelledId,
            ),
          };
        }
        // Pre-slot REPLACE with no accepted service — open the FAQ catalog guide
        // (same as «Обрати іншу процедуру») instead of guessing consultation.
        if (
          !hadOriginal
          && completed != null
          && completed.serviceAcceptance?.status !== "accepted"
        ) {
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
        }
      } else if (cancelDeclined && state.bookingDraft?.replacement?.status === "cancelling") {
        Object.assign(update, closedBookingSessionUpdate());
      } else if (!cancelOnlyCommitted) {
        const mutationFailed = resultMessages.some(
          (message) =>
            message instanceof ToolMessage
            && classifyMeetingMutationToolMessage(message) === "failed",
        );
        const mutationDeclined = resultMessages.some(
          (message) =>
            message instanceof ToolMessage
            && (message.name === "create_meeting" || message.name === "reschedule_meeting")
            && meetingMutationIsHitlDecline(message),
        );
        const mutationCommitted = committed.length > 0;
        if (state.bookingDraft && (mutationFailed || mutationDeclined) && !mutationCommitted) {
          // A CRM race/error or a patient-declined booking invalidates only the
          // selected slot. Keep the accepted service and note so a later
          // availability search still uses the service duration.
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft,
              pendingInteraction: state.pendingInteraction ?? null,
            },
            { type: "draft_event", event: { type: "slot_invalidated" } },
          );
          update.bookingDraft = session.bookingDraft;
          update.pendingInteraction = session.pendingInteraction;
        } else if (state.bookingDraft) {
          Object.assign(update, closedBookingSessionUpdate());
        }
      }
      if (
        resultMessages.some(
          (message) => message instanceof ToolMessage && meetingMutationIsHitlDecline(message),
        )
      ) {
        trackEvent("booking_note_step", { phase: "reset", reason: "hitl_declined" });
      }
    } else {
      const capturedAvailability = captureAvailabilityFromMessages(resultMessages);
      if (capturedAvailability !== undefined) {
        const acceptedService = state.bookingDraft?.serviceAcceptance;
        const bookingAvailability = capturedAvailability != null
          && acceptedService?.status === "accepted"
          ? { ...capturedAvailability, serviceId: acceptedService.service.id }
          : capturedAvailability;
        update.availabilityContext = bookingAvailability;
        update.availabilityCursor = availabilityCursorFromContext(bookingAvailability);
        const reconciliation = reconcileRequestedTime(state.bookingDraft, bookingAvailability);
        if (reconciliation.kind === "matched" && state.bookingDraft) {
          const session = reduceBookingSession(
            {
              bookingDraft: state.bookingDraft,
              pendingInteraction: state.pendingInteraction ?? null,
            },
            { type: "slot_selected", slot: reconciliation.slot },
          );
          update.bookingDraft = session.bookingDraft;
          update.pendingInteraction = session.pendingInteraction;
        } else if (reconciliation.kind === "unavailable" && state.bookingDraft) {
          update.bookingDraft = reduceBookingDraft(state.bookingDraft, {
            type: "requested_time_unavailable",
          });
        }
        const bookingDraft = (update.bookingDraft as BookingDraft | undefined) ?? state.bookingDraft;
        const selectedDate = bookingDraft?.selectedDate;
        const selectedSlot = bookingDraft?.selectedSlot ?? null;
        const selectedDay = selectedDate == null
          ? undefined
          : bookingAvailability?.days.find((day) => day.date === selectedDate);
        const selectedSlotStillAvailable = availabilityMatchesBooking(
          bookingAvailability,
          bookingDraft,
        )
          && (selectedSlot == null
            || selectedDay?.slots.some((slot) =>
              slot.dateStart === selectedSlot.dateStart && slot.dateEnd === selectedSlot.dateEnd,
            ) === true);
        if (
          selectedDate != null
          && (
            bookingAvailability == null
            || selectedDay?.slots.length === 0
            || !selectedSlotStillAvailable
          )
        ) {
          if (bookingDraft) {
            const session = reduceBookingSession(
              {
                bookingDraft,
                pendingInteraction:
                  (update.pendingInteraction as typeof state.pendingInteraction | undefined)
                  ?? state.pendingInteraction
                  ?? null,
              },
              {
                type: "draft_event",
                event: {
                  type: "slot_invalidated",
                  keepDate: selectedDay?.slots.length !== 0,
                },
              },
            );
            update.bookingDraft = session.bookingDraft;
            update.pendingInteraction = session.pendingInteraction;
          }
        }
      }
    }

    const capturedServices = captureServicesFromMessages(resultMessages);
    if (capturedServices !== undefined) {
      update.servicesContext = capturedServices;
    }

    const found = captureLatestToolContext(
      resultMessages,
      "find_contact_by_phone",
      normalizeContactLookupResult,
    );
    let projectedBookingDraft = Object.prototype.hasOwnProperty.call(update, "bookingDraft")
      ? (update.bookingDraft as BookingDraft | null)
      : state.bookingDraft;

    if (found && !found.error) {
      if (found.contacts.length > 0) {
        update.contactContext = { ...found, ownership: "phone" };
      }
      const lookupMessage = [...resultMessages]
        .reverse()
        .find((message) =>
          message instanceof ToolMessage && message.name === "find_contact_by_phone",
        );
      const lookupCall = lookupMessage instanceof ToolMessage
        ? agentMessages
          .filter((candidate): candidate is AIMessage => candidate instanceof AIMessage)
          .flatMap((candidate) => candidate.tool_calls ?? [])
          .find((candidate) => candidate.id === lookupMessage.tool_call_id)
        : undefined;
      const queriedPhone = typeof lookupCall?.args?.phoneNumber === "string"
        ? (normalizeClinicPhone(lookupCall.args.phoneNumber) ?? lookupCall.args.phoneNumber.trim())
        : projectedBookingDraft?.contactDetails?.phoneNumber ?? null;
      if (queriedPhone != null && queriedPhone.length > 0 && projectedBookingDraft != null) {
        const evidence = classifyPhoneLookupResult(found.contacts, queriedPhone);
        projectedBookingDraft = reduceBookingDraft(projectedBookingDraft, {
          type: "phone_lookup_recorded",
          evidence,
        });
        update.bookingDraft = projectedBookingDraft;
      }
    }

    for (const message of resultMessages) {
      if (!(message instanceof ToolMessage)) {
        continue;
      }
      if (
        message.name !== "create_contact"
        && message.name !== "link_telegram_to_contact"
        && message.name !== "update_contact"
      ) {
        continue;
      }
      if (authorizationFailure) {
        continue;
      }
      const record = asJsonRecord(extractMessageTextContent(message.content).trim());
      if (!record || typeof record.error === "string") {
        continue;
      }
      const call = agentMessages
        .filter((candidate): candidate is AIMessage => candidate instanceof AIMessage)
        .flatMap((candidate) => candidate.tool_calls ?? [])
        .find((candidate) => candidate.id === message.tool_call_id);
      const args = call?.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? call.args as Record<string, unknown>
        : {};
      const resolvedContactId = typeof record.id === "string" && record.id.length > 0
        ? record.id
        : null;
      const requestedContactId = message.name === "link_telegram_to_contact"
        ? args.contactId
        : message.name === "update_contact"
          ? args.contactId
          : null;
      if (
        resolvedContactId == null
        || ((message.name === "link_telegram_to_contact" || message.name === "update_contact")
          && resolvedContactId !== requestedContactId)
      ) {
        continue;
      }
      const previous = (update.contactContext as ClinicState["contactContext"] | undefined)
        ?? state.contactContext;
      const previousRow = previous?.contacts.find((contact) => contact.id === resolvedContactId) ?? {};
      if (message.name === "update_contact" && Object.keys(previousRow).length === 0) {
        continue;
      }
      // CRM projection only — never copy unpersisted draft contactDetails here.
      const createdRow = message.name === "create_contact"
        ? {
            ...previousRow,
            id: resolvedContactId,
            ...(typeof args.firstName === "string" ? { firstName: args.firstName } : {}),
            ...(typeof args.lastName === "string" ? { lastName: args.lastName } : {}),
            ...(typeof args.phoneNumber === "string" ? { phoneNumber: args.phoneNumber } : {}),
          }
        : message.name === "link_telegram_to_contact"
          ? { ...previousRow, id: resolvedContactId }
          : {
              ...previousRow,
              id: resolvedContactId,
              ...(typeof args.firstName === "string" ? { firstName: args.firstName } : {}),
              ...(typeof args.lastName === "string" ? { lastName: args.lastName } : {}),
              ...(typeof args.phoneNumber === "string" ? { phoneNumber: args.phoneNumber } : {}),
            };
      const ownership = message.name === "create_contact" || message.name === "link_telegram_to_contact"
        ? "telegram" as const
        : previous?.ownership;
      const missing = contactMissingFields(createdRow);
      update.contactContext = {
        ...(ownership ? { ownership } : {}),
        contacts: [{ ...createdRow, missingFields: missing }],
      };
      if (projectedBookingDraft) {
        // Clear accepted details only once CRM is complete (create or finished update).
        // Link keeps contactDetails so a follow-up update_contact can use them.
        const clearDetails = message.name === "create_contact"
          || (message.name === "update_contact" && missing.length === 0);
        projectedBookingDraft = reduceBookingDraft(projectedBookingDraft, {
          type: "contact_resolved",
          contactId: resolvedContactId,
          ...(clearDetails ? { clearDetails: true } : {}),
        });
        update.bookingDraft = projectedBookingDraft;
      }
    }

    if (crmWriteDirtiesPrefetch(resultMessages)) {
      update.prefetchDirty = true;
    }

    return update;
};

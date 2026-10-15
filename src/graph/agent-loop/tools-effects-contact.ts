import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { asJsonRecord } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import { contactMissingFields, normalizeContactLookupResult } from "../../tools/contact-tools.js";
import { reduceBookingDraft, type BookingDraft } from "../booking-draft.js";
import { classifyPhoneLookupResult } from "../contact-command.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import {
  captureLatestToolContext,
  meetingMutationUnauthorizedThisTurn,
} from "./protocol.js";

/** Phone lookup evidence + create/link/update CRM row projection. */
export const projectContactEffects = (input: {
  state: ClinicState;
  resultMessages: BaseMessage[];
}): ClinicStateUpdate => {
  const { state, resultMessages } = input;
  const patch: ClinicStateUpdate = {};
  const agentMessages = state.agentMessages ?? [];

  const authorizationFailure = meetingMutationUnauthorizedThisTurn(resultMessages);

  const found = captureLatestToolContext(
    resultMessages,
    "find_contact_by_phone",
    normalizeContactLookupResult,
  );
  let projectedBookingDraft: BookingDraft | null | undefined = state.bookingDraft;

  if (found && !found.error) {
    if (found.contacts.length > 0) {
      patch.contactContext = { ...found, ownership: "phone" };
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
      patch.bookingDraft = projectedBookingDraft;
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
    const previous = (Object.prototype.hasOwnProperty.call(patch, "contactContext")
      ? (patch.contactContext as ClinicState["contactContext"])
      : state.contactContext);
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
    patch.contactContext = {
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
      patch.bookingDraft = projectedBookingDraft;
    }
  }

  return patch;
};

import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { asJsonRecord } from "../../../shared/json-record.js";
import { extractRawMessageText } from "../../../shared/message-content.js";
import { contactMissingFields, normalizeContactLookupResult } from "../../../tools/contact-tools.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import {
  captureLatestToolContext,
  meetingMutationUnauthorizedThisTurn,
} from "../protocol/index.js";

/**
 * CRM contactContext projection only.
 * Draft events (phone_lookup_recorded / contact_resolved) belong to decide via EffectResult.
 */
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

  if (found && !found.error && found.contacts.length > 0) {
    patch.contactContext = { ...found, ownership: "phone" };
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
    const record = asJsonRecord(extractRawMessageText(message.content).trim());
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
      || (message.name === "update_contact" && record.contactId !== requestedContactId)
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
        : record.success === true
          ? {
              ...previousRow,
              id: resolvedContactId,
              ...Object.fromEntries(
                ["firstName", "lastName", "phoneNumber", "cTelegram"].flatMap((field) =>
                  typeof record[field] === "string" ? [[field, record[field]]] : [],
                ),
              ),
            }
        : {
            ...previousRow,
          };
    if (message.name === "update_contact" && record.success !== true) {
      continue;
    }
    const ownership = message.name === "create_contact" || message.name === "link_telegram_to_contact"
      ? "telegram" as const
      : previous?.ownership;
    const missing = contactMissingFields(createdRow);
    patch.contactContext = {
      ...(ownership ? { ownership } : {}),
      contacts: [{ ...createdRow, missingFields: missing }],
    };
  }

  return patch;
};

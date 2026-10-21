import { ToolMessage } from "@langchain/core/messages";
import { asJsonRecord, jsonEntityId } from "../../../shared/json-record.js";
import { extractRawMessageText } from "../../../shared/message-content.js";
import type { ClinicState } from "../../state.js";
import {
  NAME_NOT_PROVIDED_ERROR,
  PHONE_NOT_PROVIDED_ERROR,
} from "./patient-evidence.js";

/** Contact CRM writes that must not same-turn retry after known_field / operational failure. */
export const CONTACT_WRITE_TOOLS = new Set([
  "create_contact",
  "update_contact",
  "link_telegram_to_contact",
]);

export type ContactWriteOutcome = "success" | "known_field" | "operational" | null;

export type ContactWriteClassification = {
  outcome: ContactWriteOutcome;
  tool: string;
  /** Present for known_field when the synthetic error names a specific identity field. */
  field?: "phoneNumber" | "firstName" | "lastName";
  /** Structured synthetic error constant when outcome is known_field. */
  error?: string;
  category?: "known_field" | "operational";
};

export const CONTACT_OWNERSHIP_REQUIRED_ERROR = "Contact ownership required";

export const CONTACT_LINK_CANDIDATE_REQUIRED_ERROR = "Contact link candidate required";

const KNOWN_CONTACT_FIELD_ERRORS = new Set([
  PHONE_NOT_PROVIDED_ERROR,
  NAME_NOT_PROVIDED_ERROR,
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
]);

const contactWriteFieldFromRecord = (
  record: Record<string, unknown>,
  error: string,
): ContactWriteClassification["field"] => {
  const raw = record.field;
  if (raw === "phoneNumber" || raw === "firstName" || raw === "lastName") {
    return raw;
  }
  if (error === PHONE_NOT_PROVIDED_ERROR || error === CONTACT_LINK_CANDIDATE_REQUIRED_ERROR) {
    return "phoneNumber";
  }
  return undefined;
};

/**
 * Classify create_contact / update_contact / link_telegram_to_contact results.
 * Never branches on free-form Espo text — only structured error constants or missing entity id.
 */
export const classifyContactWriteToolMessage = (
  message: ToolMessage,
): ContactWriteClassification | null => {
  const name = message.name;
  if (!name || !CONTACT_WRITE_TOOLS.has(name)) {
    return null;
  }
  const body = extractRawMessageText(message.content).trim();
  if (body.startsWith("Error:")) {
    return { outcome: "operational", tool: name, category: "operational" };
  }
  const record = asJsonRecord(body);
  if (!record) {
    return { outcome: "operational", tool: name, category: "operational" };
  }
  if (typeof record.error === "string") {
    if (KNOWN_CONTACT_FIELD_ERRORS.has(record.error)) {
      const field = contactWriteFieldFromRecord(record, record.error);
      return {
        outcome: "known_field",
        tool: name,
        category: "known_field",
        error: record.error,
        ...(field != null ? { field } : {}),
      };
    }
    return { outcome: "operational", tool: name, category: "operational" };
  }
  if (jsonEntityId(body) != null) {
    return { outcome: "success", tool: name };
  }
  // Malformed "success" without an entity id is operational, not projected.
  return { outcome: "operational", tool: name, category: "operational" };
};

/**
 * Newest contact-write result this turn when it is known_field or operational.
 * A later success supersedes an earlier failure in the same tape.
 */
export const terminalContactWriteOutcome = (
  state: ClinicState,
): { message: ToolMessage; classification: ContactWriteClassification } | null => {
  for (let index = (state.agentMessages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = state.agentMessages?.[index];
    if (!(message instanceof ToolMessage) || !CONTACT_WRITE_TOOLS.has(message.name ?? "")) {
      continue;
    }
    const classification = classifyContactWriteToolMessage(message);
    if (classification == null) {
      continue;
    }
    if (classification.outcome === "success") {
      return null;
    }
    if (classification.outcome === "known_field" || classification.outcome === "operational") {
      return { message, classification };
    }
  }
  return null;
};

/**
 * find_contact_by_phone returned a structured error (does not throw). Terminal
 * for this turn so command_prepare cannot lookup-loop; next patient turn retries.
 */
export const phoneLookupFailedThisTurn = (state: ClinicState): boolean => {
  const messages = state.agentMessages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof ToolMessage) || message.name !== "find_contact_by_phone") {
      continue;
    }
    const body = extractRawMessageText(message.content).trim();
    if (body.startsWith("Error:")) {
      return true;
    }
    const record = asJsonRecord(body);
    return typeof record?.error === "string" && record.error.length > 0;
  }
  return false;
};

import {
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  extractMessageTextContent,
  extractRawMessageText,
} from "../../../shared/message-content.js";
import { asJsonRecord } from "../../../shared/json-record.js";
import type { ClinicState } from "../../state.js";

/** CRM writes that invalidate checkpointed contact/meetings prefetch. */
const PREFETCH_INVALIDATING_TOOLS = new Set([
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "create_meeting",
  "cancel_meeting",
  "reschedule_meeting",
]);

export const toolMessageName = (message: BaseMessage): string | undefined => {
  const name = (message as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
};

/** True when a ToolMessage for this tool is already in the current agent turn. */
export const toolRanThisTurn = (messages: BaseMessage[], toolName: string): boolean =>
  messages.some(
    (message) => message instanceof ToolMessage && toolMessageName(message) === toolName,
  );

export const captureLatestToolContext = <T>(
  messages: BaseMessage[],
  toolName: string,
  normalize: (raw: string) => T | null,
): T | null | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || toolMessageName(message) !== toolName) {
      continue;
    }
    return normalize(extractRawMessageText(message.content)) ?? undefined;
  }
  return undefined;
};

const lastHumanText = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof HumanMessage) {
      return extractMessageTextContent(message.content).trim();
    }
  }
  return "";
};

export const lastPatientText = (state: ClinicState): string =>
  lastHumanText(state.messages) || lastHumanText(state.agentMessages ?? []);

export const crmWriteDirtiesPrefetch = (messages: BaseMessage[]): boolean =>
  messages.some((message) => {
    if (!(message instanceof ToolMessage)) {
      return false;
    }
    const name = message.name;
    if (!name || !PREFETCH_INVALIDATING_TOOLS.has(name)) {
      return false;
    }
    const body = extractMessageTextContent(message.content).trim();
    if (body.startsWith("Error:")) {
      return false;
    }
    const record = asJsonRecord(body);
    if (!record) {
      return true;
    }
    if (typeof record.error === "string") {
      return name === "cancel_meeting";
    }
    return record.cancelled !== true && record.awaitingConfirmation !== true;
  });

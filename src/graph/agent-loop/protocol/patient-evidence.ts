import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { extractMessageTextContent } from "../../../shared/message-content.js";
import { normalizeClinicPhone } from "../../../shared/phone.js";

export const PHONE_GROUNDED_TOOLS = new Set([
  "find_contact_by_phone",
  "create_contact",
  "update_contact",
]);

export const PHONE_NOT_PROVIDED_ERROR = "Phone not provided";

export const NAME_NOT_PROVIDED_ERROR = "Name not provided";

/** True when some HumanMessage in `messages` normalizes to the same E.164 as `wanted`. */
export const humanProvidedPhone = (messages: BaseMessage[], wanted: string): boolean =>
  messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    return normalizeClinicPhone(extractMessageTextContent(message.content)) === wanted;
  });

/**
 * Compare-only name fold for DDD-59 grounding (DDD-206).
 * Trims, lowercases, and maps documented apostrophe glyphs to ASCII `'`.
 * Does not rewrite values stored on collected or forwarded to CRM.
 */
export const normalizeNameForMatch = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    // U+0027 apostrophe, U+2019 right single quotation, U+2018 left single quotation, U+02BC modifier letter apostrophe
    .replace(/['’‘ʼ]/g, "'");

/**
 * True when some HumanMessage equals `wanted` (normalizeNameForMatch), or is two whitespace
 * tokens and `wanted` equals token 0 or 1 (DDD-59 name grounding).
 */
export const humanProvidedName = (messages: BaseMessage[], wanted: string): boolean => {
  const target = normalizeNameForMatch(wanted);
  if (target.length === 0) {
    return false;
  }
  return messages.some((message) => {
    if (!(message instanceof HumanMessage)) {
      return false;
    }
    const text = normalizeNameForMatch(extractMessageTextContent(message.content));
    if (text === target) {
      return true;
    }
    const parts = text.split(/\s+/).filter((part) => part.length > 0);
    return parts.length === 2 && (parts[0] === target || parts[1] === target);
  });
};

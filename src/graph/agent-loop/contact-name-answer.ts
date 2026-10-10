import { normalizeClinicPhone } from "../../shared/phone.js";

const MAX_NAME_ANSWER_LEN = 48;
const MAX_NAME_ANSWER_WORDS = 3;

/**
 * Patient line looks like a first/last name answer (not a phone, question, or ramble).
 * Used to advance the unresolved contact_field ladder.
 */
export const looksLikeContactNameAnswer = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_ANSWER_LEN) {
    return false;
  }
  if (normalizeClinicPhone(trimmed) != null) {
    return false;
  }
  if (/[?!？]/.test(trimmed)) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_NAME_ANSWER_WORDS) {
    return false;
  }
  if (!/^[\p{L}][\p{L}'’\-\s]*$/u.test(trimmed)) {
    return false;
  }
  return true;
};

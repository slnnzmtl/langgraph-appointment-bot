import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  BOOKING_REPLACE_MENU_EN,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  VISIT_CHANGE_MENU,
  VISIT_CHANGE_MENU_EN,
} from "./clinic-constants.js";

/** Known keyboard labels that must not collide with an «Інша дата» prefix tap. */
const OTHER_DATE_COLLISION_LABELS = [
  MAIN_MENU_LABEL,
  ...DEFAULT_MENU_NO_VISITS,
  ...DEFAULT_MENU_HAS_VISITS,
  ...BOOKING_OFFER_MENU,
  ...BOOKING_OFFER_MENU_EN,
  ...BOOKING_REPLACE_MENU,
  ...BOOKING_REPLACE_MENU_EN,
  ...VISIT_CHANGE_MENU,
  ...VISIT_CHANGE_MENU_EN,
  INTENT_SKIP_LABEL,
  INTENT_SKIP_LABEL_EN,
  "Book",
  "Services",
  "Address",
  "My visit",
].map((label) => label.toLowerCase());

const RUSSIAN_OTHER_DATE_RE =
  /^(?:другая|другой|другую|другие)(?:\s+(?:дата|дату|даты|день|дни|вариант(?:ы)?))?$/i;

/**
 * Exact Ukrainian/English «Інша дата» chip, its unique prefix (≥4 chars, e.g. «Інша»),
 * or a standalone Russian equivalent (e.g. «другая», «другой»).
 * Rejects a prefix that also prefixes another known keyboard label.
 */
export const isOtherDateChip = (humanText: string): boolean => {
  const normalized = humanText.trim().toLowerCase();
  if (normalized.length < 4) {
    return false;
  }
  if (RUSSIAN_OTHER_DATE_RE.test(normalized)) {
    return true;
  }
  const targets = [OTHER_DATE_LABEL, OTHER_DATE_LABEL_EN].map((label) => label.toLowerCase());
  const matched = targets.find(
    (target) => normalized === target || target.startsWith(normalized),
  );
  if (!matched) {
    return false;
  }
  if (normalized === matched) {
    return true;
  }
  return !OTHER_DATE_COLLISION_LABELS.some(
    (label) => label.startsWith(normalized) && !targets.includes(label),
  );
};

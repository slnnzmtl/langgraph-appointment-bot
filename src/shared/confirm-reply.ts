import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
} from "./clinic-constants.js";
import { labelIdFor } from "./message-content.js";

export type ConfirmReplyDecision =
  | { kind: "confirmed" }
  | { kind: "declined" }
  /** Main menu — dismiss confirm UI without treating as ❌ (no Not Held on reminders). */
  | { kind: "leave" }
  | { kind: "chat" };

export const stripConfirmVariationSelectors = (text: string): string =>
  text.trim().replace(/\uFE0F|\uFE0E/g, "");

/** Map ✅ / ❌ / main-menu shortcuts vs free chat while a confirm keyboard is open. */
export const classifyConfirmReply = (text: string): ConfirmReplyDecision => {
  const stripped = stripConfirmVariationSelectors(text);
  if (stripped === CONFIRM_YES_LABEL) {
    return { kind: "confirmed" };
  }
  if (stripped === CONFIRM_NO_LABEL) {
    return { kind: "declined" };
  }
  if (labelIdFor(text) === "mainMenu") {
    return { kind: "leave" };
  }
  return { kind: "chat" };
};

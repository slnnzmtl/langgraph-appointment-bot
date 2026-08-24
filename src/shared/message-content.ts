import type { BaseMessage } from "@langchain/core/messages";

type NonTextContentPart = Exclude<
  Extract<BaseMessage["content"], readonly unknown[]>[number],
  string | { type: "text"; text: string }
>;

/**
 * Gemini flash often writes the two-character sequence \\n (sometimes twice-escaped)
 * instead of a real line break. Decode that so Telegram can show paragraphs.
 */
export const unescapeModelLineBreaks = (text: string): string => {
  let result = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (let pass = 0; pass < 2; pass += 1) {
    if (!result.includes("\\n") && !result.includes("\\t")) {
      break;
    }
    result = result.replaceAll("\\n", "\n").replaceAll("\\t", "\t");
  }
  return result.replace(/<br\s*\/?>/gi, "\n");
};

export const extractMessageTextContent = (content: BaseMessage["content"]): string => {
  if (typeof content === "string") {
    return unescapeModelLineBreaks(content);
  }

  if (Array.isArray(content)) {
    return unescapeModelLineBreaks(
      content
        .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
        .join("\n"),
    );
  }

  if (content == null) {
    return "";
  }

  return JSON.stringify(content);
};

export const extractNonTextContentParts = (
  content: BaseMessage["content"],
): NonTextContentPart[] => {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter((part): part is NonTextContentPart => {
    if (typeof part === "string") {
      return false;
    }

    return part.type !== "text";
  });
};

const MAX_REPLY_BUTTONS = 4;

/** Trailer from the first `<reply_buttons>` to EOF (model may emit one or several blocks). */
const REPLY_BUTTONS_TRAILER = /(?:\r?\n)*<reply_buttons\b[\s\S]*$/i;

const REPLY_BUTTON_TAG = /<\/?reply_buttons\b[^>]*>/gi;

export type ExtractedReplyButtons = {
  text: string;
  buttons: string[];
};

/** Strip a trailing `<reply_buttons>` trailer and return up to 4 unique labels. */
export const extractReplyButtons = (raw: string): ExtractedReplyButtons => {
  const match = raw.match(REPLY_BUTTONS_TRAILER);
  if (!match || match.index === undefined) {
    return { text: raw, buttons: [] };
  }

  const before = raw.slice(0, match.index).trimEnd();
  const trailer = match[0];
  // When a closing tag exists, labels stop at the last one; any prose after it
  // stays in the visible reply instead of becoming a button label.
  const closeTag = /<\/reply_buttons\b[^>]*>/gi;
  let lastCloseEnd = -1;
  for (const close of trailer.matchAll(closeTag)) {
    lastCloseEnd = (close.index ?? 0) + close[0].length;
  }
  const labelSource = lastCloseEnd >= 0 ? trailer.slice(0, lastCloseEnd) : trailer;
  const after = lastCloseEnd >= 0 ? trailer.slice(lastCloseEnd).trim() : "";

  // Split on tags and newlines so jammed blocks like
  // `A</reply_buttons><reply_buttons>B` become separate labels.
  const seen = new Set<string>();
  const buttons: string[] = [];
  for (const chunk of labelSource.replace(REPLY_BUTTON_TAG, "\n").split(/\r?\n/)) {
    const label = chunk.trim();
    if (!label || label.includes("<") || label.includes(">")) {
      continue;
    }
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    buttons.push(label);
    if (buttons.length >= MAX_REPLY_BUTTONS) {
      break;
    }
  }

  const text = after.length > 0
    ? (before.length > 0 ? `${before}\n\n${after}` : after)
    : before;
  return { text, buttons };
};

/** Prefer checkpointed `lastHandoff.replyButtons`; fall back to a message trailer. */
export const replyButtonLabels = (stored: unknown, rawText?: string): string[] => {
  if (
    Array.isArray(stored)
    && stored.length > 0
    && stored.every((label) => typeof label === "string")
  ) {
    return stored;
  }
  if (rawText !== undefined) {
    return extractReplyButtons(rawText).buttons;
  }
  return [];
};

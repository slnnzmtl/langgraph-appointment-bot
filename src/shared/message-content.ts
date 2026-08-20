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

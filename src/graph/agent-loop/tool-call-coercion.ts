import { AIMessage } from "@langchain/core/messages";

import { trackToolError } from "../../analytics/track.js";
import {
  extractRawMessageText,
  stripLeakedModelToolCalls,
} from "../../shared/message-content.js";
import { rewriteAiMessage } from "./rewrite-ai-message.js";

/**
 * Sanitize model tool calls before ToolNode: drop non-allowlisted names (stale
 * native / leaked runtime tools) and strip leaked Gemini XML from content.
 * Do not promote leaked markup into executable tool_calls — native structured
 * calls are the only model-owned execution protocol (DDD-266).
 */
export const sanitizeBoundModelToolCalls = (
  response: AIMessage,
  allowedToolNames: ReadonlySet<string>,
): AIMessage => {
  const raw = extractRawMessageText(response.content);
  const existingRaw = response.tool_calls ?? [];
  for (const call of existingRaw) {
    if (!allowedToolNames.has(call.name)) {
      trackToolError(call.name, "disallowed_tool_call");
    }
  }
  const toolCalls = existingRaw.filter((call) => allowedToolNames.has(call.name));

  const contentWasString = typeof response.content === "string";
  let nextContent: AIMessage["content"] = response.content;
  let contentChanged = false;
  if (contentWasString) {
    const original = response.content as string;
    const stripped = stripLeakedModelToolCalls(original);
    if (stripped !== original) {
      nextContent = stripped;
      contentChanged = true;
    }
  } else if (Array.isArray(response.content)) {
    const originalParts = response.content;
    const strippedParts = originalParts.map((part) => {
      if (typeof part === "string") {
        return stripLeakedModelToolCalls(part);
      }
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        const text = String((part as { text: string }).text);
        const stripped = stripLeakedModelToolCalls(text);
        return stripped === text ? part : { ...part, text: stripped };
      }
      return part;
    });
    const partsChanged = strippedParts.some((part, index) => part !== originalParts[index]);
    if (partsChanged) {
      nextContent = strippedParts as typeof response.content;
      contentChanged = true;
    }
  } else {
    const stripped = stripLeakedModelToolCalls(raw);
    if (stripped !== raw) {
      nextContent = stripped;
      contentChanged = true;
    }
  }

  if (
    !contentChanged
    && toolCalls.length === existingRaw.length
  ) {
    return response;
  }

  return rewriteAiMessage(response, {
    content: nextContent,
    tool_calls: toolCalls,
  });
};

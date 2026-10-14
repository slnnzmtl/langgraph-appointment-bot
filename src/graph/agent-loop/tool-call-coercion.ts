import { AIMessage } from "@langchain/core/messages";

import { trackToolError } from "../../analytics/track.js";
import {
  extractRawMessageText,
  parseLeakedModelToolCalls,
  stripLeakedModelToolCalls,
} from "../../shared/message-content.js";
import type { ClinicState } from "../state.js";

/**
 * Sanitize model tool calls before ToolNode: drop non-allowlisted names (stale
 * native / leaked runtime tools) and hydrate leaked Gemini XML into allowlisted
 * informational calls only. Availability and mutations are runtime-owned via
 * command_prepare — never synthesized here.
 */
export const coerceAvailabilityToolCalls = (
  response: AIMessage,
  _state: ClinicState,
  _agentId: string,
  allowedToolNames: ReadonlySet<string>,
): AIMessage => {
  const raw = extractRawMessageText(response.content);
  const leaked = parseLeakedModelToolCalls(raw).filter((call) =>
    allowedToolNames.has(call.name),
  );
  const existingRaw = response.tool_calls ?? [];
  for (const call of existingRaw) {
    if (!allowedToolNames.has(call.name)) {
      trackToolError("disallowed_tool_call", call.name);
    }
  }
  const allowlisted = existingRaw.filter((call) => allowedToolNames.has(call.name));
  let toolCalls = allowlisted;
  if (allowlisted.length === 0 && leaked.length > 0) {
    toolCalls = leaked.map((call, index) => ({
      id: `leaked_${call.name}_${index}`,
      name: call.name,
      args: call.args,
      type: "tool_call" as const,
    }));
  }

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
    && toolCalls === allowlisted
    && allowlisted.length === existingRaw.length
  ) {
    return response;
  }

  return new AIMessage({
    content: nextContent,
    tool_calls: toolCalls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
  });
};

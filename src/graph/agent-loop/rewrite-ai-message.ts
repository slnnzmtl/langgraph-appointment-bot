import { AIMessage } from "@langchain/core/messages";

export type AiMessageRewritePatch = {
  content?: AIMessage["content"];
  tool_calls?: NonNullable<AIMessage["tool_calls"]>;
};

/**
 * Rebuild an AIMessage while preserving id, name, and metadata.
 * Callers only patch content / tool_calls; everything else is copied.
 */
export const rewriteAiMessage = (
  message: AIMessage,
  patch: AiMessageRewritePatch,
): AIMessage =>
  new AIMessage({
    content: patch.content ?? message.content,
    tool_calls: patch.tool_calls ?? message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    id: message.id,
    name: message.name,
    usage_metadata: message.usage_metadata,
  } as ConstructorParameters<typeof AIMessage>[0]);

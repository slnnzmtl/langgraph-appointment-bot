import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { extractMessageTextContent } from "../shared/message-content.js";

const mergeMessages = (message: BaseMessage, nextMessage: BaseMessage): BaseMessage => {
  const mergedContent =
    `${extractMessageTextContent(message.content)}\n${extractMessageTextContent(nextMessage.content)}`.trim();

  if (nextMessage instanceof HumanMessage) {
    return new HumanMessage(mergedContent);
  }

  return new AIMessage(mergedContent);
};

export const stripToolNoiseFromMessages = (messages: BaseMessage[]): BaseMessage[] => {
  const result: BaseMessage[] = [];

  for (const message of messages) {
    const isToolMessage = message instanceof ToolMessage || message._getType() === "tool";

    if (isToolMessage) {
      continue;
    }

    const hasToolCalls =
      message instanceof AIMessage &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0;

    const normalizedMessage = hasToolCalls
      ? new AIMessage({ content: extractMessageTextContent(message.content) })
      : message;

    if (result.length === 0) {
      result.push(normalizedMessage);
      continue;
    }

    const lastMessage = result[result.length - 1];
    if (!lastMessage) {
      result.push(normalizedMessage);
      continue;
    }

    const lastType = lastMessage._getType();
    const currentType = normalizedMessage._getType();

    if (lastType === currentType && (currentType === "human" || currentType === "ai")) {
      result[result.length - 1] = mergeMessages(lastMessage, normalizedMessage);
      continue;
    }

    result.push(normalizedMessage);
  }

  return result;
};

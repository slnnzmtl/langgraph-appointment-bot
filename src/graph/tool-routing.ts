import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

export const findLastAIMessage = (messages: BaseMessage[]): AIMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message instanceof AIMessage) {
      return message;
    }
  }

  return undefined;
};

export const hasPendingToolCalls = (messages: BaseMessage[]): boolean => {
  const aiMessage = findLastAIMessage(messages);
  const toolCalls = aiMessage?.tool_calls;

  if (!toolCalls?.length) {
    return false;
  }

  const fulfilledIds = new Set(
    messages
      .filter((message): message is ToolMessage => message instanceof ToolMessage)
      .map((message) => message.tool_call_id)
      .filter(Boolean),
  );

  return toolCalls.some((call) => !call.id || !fulfilledIds.has(call.id));
};

export const lastMessageRequestsTools = (messages: BaseMessage[]): boolean => {
  const lastMessage = messages[messages.length - 1];

  if (!(lastMessage instanceof AIMessage)) {
    return false;
  }

  return (lastMessage.tool_calls?.length ?? 0) > 0;
};

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import {
  extractMessageTextContent,
  extractNonTextContentParts,
} from "../shared/message-content.js";

export const RUNTIME_AGENT_CONTEXT_KEY = "runtimeAgentId" as const;
export const SUB_AGENT_CONTEXT_HUMAN_TURNS = 3;

const isHumanMessage = (message: BaseMessage): boolean =>
  message instanceof HumanMessage || message._getType() === "human";

const isAiMessage = (message: BaseMessage): boolean =>
  message instanceof AIMessage || message._getType() === "ai";

export const getRuntimeAgentIdFromMessage = (message: BaseMessage): string | undefined => {
  const value = message.additional_kwargs?.[RUNTIME_AGENT_CONTEXT_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const tagRuntimeAgentMessage = (message: AIMessage, agentId: string): AIMessage => {
  message.additional_kwargs = {
    ...message.additional_kwargs,
    [RUNTIME_AGENT_CONTEXT_KEY]: agentId,
  };
  return message;
};

const collapseConsecutiveAssistantMessages = (messages: BaseMessage[]): BaseMessage[] => {
  const result: BaseMessage[] = [];

  for (const message of messages) {
    const last = result[result.length - 1];
    if (last && isAiMessage(last) && isAiMessage(message)) {
      result[result.length - 1] = message;
      continue;
    }
    result.push(message);
  }

  return result;
};

const stripStaleNonTextFromOlderHumans = (messages: BaseMessage[]): BaseMessage[] => {
  let lastHumanIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isHumanMessage(message)) {
      lastHumanIndex = index;
      break;
    }
  }

  if (lastHumanIndex === -1) {
    return messages;
  }

  const lastHuman = messages[lastHumanIndex]!;
  const lastHumanNonText = extractNonTextContentParts(lastHuman.content);
  let sourceNonTextIndex = -1;
  let movedParts = lastHumanNonText;

  if (lastHumanNonText.length === 0) {
    for (let index = lastHumanIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || !isHumanMessage(message)) {
        continue;
      }

      const parts = extractNonTextContentParts(message.content);
      if (parts.length > 0) {
        sourceNonTextIndex = index;
        movedParts = parts;
        break;
      }
    }
  }

  return messages.map((message, index) => {
    if (!isHumanMessage(message)) {
      return message;
    }

    if (index === lastHumanIndex) {
      if (movedParts.length === 0 || lastHumanNonText.length > 0) {
        return message;
      }

      const text = extractMessageTextContent(message.content).trim();
      return new HumanMessage([{ type: "text", text }, ...movedParts]);
    }

    if (index === sourceNonTextIndex || extractNonTextContentParts(message.content).length > 0) {
      return new HumanMessage(extractMessageTextContent(message.content).trim());
    }

    return message;
  });
};

export const scopeSubAgentMessages = (
  messages: BaseMessage[],
  agentId: string,
  humanTurns = SUB_AGENT_CONTEXT_HUMAN_TURNS,
): BaseMessage[] => {
  const owned: BaseMessage[] = [];
  let pendingHuman: BaseMessage | undefined;

  for (const message of messages) {
    if (isHumanMessage(message)) {
      pendingHuman = message;
      continue;
    }

    if (isAiMessage(message) && getRuntimeAgentIdFromMessage(message) === agentId) {
      if (pendingHuman) {
        owned.push(pendingHuman);
        pendingHuman = undefined;
      }
      owned.push(message);
      continue;
    }

    if (isAiMessage(message)) {
      pendingHuman = undefined;
    }
  }

  if (pendingHuman) {
    owned.push(pendingHuman);
  }

  const humanIndexes: number[] = [];

  for (let index = 0; index < owned.length; index += 1) {
    const message = owned[index];
    if (message && isHumanMessage(message)) {
      humanIndexes.push(index);
    }
  }

  const recent =
    humanIndexes.length === 0
      ? owned
      : stripStaleNonTextFromOlderHumans(
          owned.slice(humanIndexes[Math.max(0, humanIndexes.length - Math.max(1, humanTurns))]!),
        );

  return collapseConsecutiveAssistantMessages(recent);
};

export const applyDelegationPrompt = (
  messages: BaseMessage[],
  prompt: string,
): BaseMessage[] => {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return messages;
  }

  let lastHumanIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isHumanMessage(message)) {
      lastHumanIndex = index;
      break;
    }
  }

  if (lastHumanIndex === -1) {
    return [new HumanMessage(trimmed), ...messages];
  }

  const previousHumanMessage = messages[lastHumanIndex];
  const preservedParts = previousHumanMessage
    ? extractNonTextContentParts(previousHumanMessage.content)
    : [];
  const nextMessages = [...messages];
  nextMessages[lastHumanIndex] =
    preservedParts.length > 0
      ? new HumanMessage([{ type: "text", text: trimmed }, ...preservedParts])
      : new HumanMessage(trimmed);
  return nextMessages;
};

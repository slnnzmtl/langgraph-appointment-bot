import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import {
  DEFAULT_MESSAGE_HISTORY_MAX_TOKENS,
  getMessageHistoryMaxTokens,
} from "../shared/message-budget.js";
import { extractMessageTextContent } from "../shared/message-content.js";

export {
  DEFAULT_MESSAGE_HISTORY_MAX_TOKENS,
  getMessageHistoryMaxTokens,
} from "../shared/message-budget.js";

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 20;

export type TrimMessagesToTokenBudgetOptions = {
  maxTokens?: number;
  tokenCounter?: (messages: BaseMessage[]) => number;
};

const estimateSingleMessageTokens = (message: BaseMessage): number => {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  tokens += Math.ceil(extractMessageTextContent(message.content).length / 4);

  if (message instanceof AIMessage && message.tool_calls?.length) {
    tokens += message.tool_calls.length * TOOL_CALL_OVERHEAD_TOKENS;
    tokens += Math.ceil(JSON.stringify(message.tool_calls).length / 4);
  }

  return tokens;
};

export const estimateMessageTokens = (messages: BaseMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateSingleMessageTokens(message), 0);

const isMessageType = (message: BaseMessage, types: string[]): boolean =>
  types.includes(message.getType());

const findActiveToolCallIndex = (messages: BaseMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage) || !message.tool_calls?.length) {
      continue;
    }

    const toolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
    const followingMessages = messages.slice(index + 1);
    const isActiveToolCall = followingMessages.every(
      (followingMessage) =>
        followingMessage instanceof ToolMessage &&
        toolCallIds.has(followingMessage.tool_call_id),
    );

    if (isActiveToolCall) {
      return index;
    }
  }

  return -1;
};

const findLatestHumanIndex = (messages: BaseMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] instanceof HumanMessage) {
      return index;
    }
  }

  return -1;
};

const firstMaxTokensSync = (
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (candidate: BaseMessage[]) => number,
  endOn?: string | string[],
): BaseMessage[] => {
  let idx = 0;

  for (let excluded = 0; excluded < messages.length; excluded += 1) {
    const prefix = messages.slice(0, messages.length - excluded);
    if (tokenCounter(prefix) <= maxTokens) {
      idx = prefix.length;
      break;
    }
  }

  if (endOn) {
    const endOnTypes = Array.isArray(endOn) ? endOn : [endOn];
    while (idx > 0 && !isMessageType(messages[idx - 1]!, endOnTypes)) {
      idx -= 1;
    }
  }

  return messages.slice(0, idx);
};

const trimLastMaxTokensSync = (
  messages: BaseMessage[],
  maxTokens: number,
  tokenCounter: (candidate: BaseMessage[]) => number,
  startOn?: string | string[],
): BaseMessage[] => {
  if (messages.length === 0 || tokenCounter(messages) <= maxTokens) {
    return messages;
  }

  const reversed = [...messages].reverse();
  const prefix = firstMaxTokensSync(reversed, maxTokens, tokenCounter, startOn);
  return prefix.reverse();
};

const buildFallbackMessages = (
  messages: BaseMessage[],
  activeToolCallIndex: number,
  latestHumanIndex: number,
): BaseMessage[] => {
  if (latestHumanIndex >= 0) {
    return messages.slice(latestHumanIndex);
  }

  if (activeToolCallIndex >= 0) {
    return messages.slice(activeToolCallIndex);
  }

  return messages.slice(-1);
};

const stripOrphanedLeadingToolMessages = (
  sliced: BaseMessage[],
  startIndex: number,
  activeToolCallIndex: number,
): BaseMessage[] => {
  let result = sliced;
  let currentStartIndex = startIndex;

  while (result.length > 0 && currentStartIndex !== activeToolCallIndex) {
    if (!(result[0] instanceof ToolMessage)) {
      break;
    }

    result = result.slice(1);
    currentStartIndex += 1;
  }

  return result;
};

export const trimMessagesToTokenBudgetSync = (
  messages: BaseMessage[],
  options: TrimMessagesToTokenBudgetOptions = {},
): BaseMessage[] => {
  const maxTokens = options.maxTokens ?? getMessageHistoryMaxTokens();
  const tokenCounter = options.tokenCounter ?? estimateMessageTokens;

  if (messages.length === 0 || tokenCounter(messages) <= maxTokens) {
    return messages;
  }

  const activeToolCallIndex = findActiveToolCallIndex(messages);
  const latestHumanIndex = findLatestHumanIndex(messages);

  if (activeToolCallIndex >= 0) {
    const activeBatch = messages.slice(activeToolCallIndex);
    if (tokenCounter(activeBatch) > maxTokens) {
      const startIndex =
        latestHumanIndex >= 0 && latestHumanIndex < activeToolCallIndex
          ? latestHumanIndex
          : activeToolCallIndex;
      return messages.slice(startIndex);
    }
  }

  let trimmed = trimLastMaxTokensSync(messages, maxTokens, tokenCounter, "human");

  if (trimmed.length === 0) {
    trimmed = buildFallbackMessages(messages, activeToolCallIndex, latestHumanIndex);
  }

  if (latestHumanIndex >= 0 && trimmed.length > 0) {
    const firstTrimmedIndex = messages.indexOf(trimmed[0]!);
    if (firstTrimmedIndex < 0 || firstTrimmedIndex > latestHumanIndex) {
      const fromHuman = messages.slice(latestHumanIndex);
      trimmed =
        tokenCounter(fromHuman) <= maxTokens || activeToolCallIndex >= 0
          ? fromHuman
          : buildFallbackMessages(messages, activeToolCallIndex, latestHumanIndex);
    }
  }

  const startIndex = trimmed.length > 0 ? messages.indexOf(trimmed[0]!) : 0;
  return stripOrphanedLeadingToolMessages(
    trimmed,
    startIndex >= 0 ? startIndex : 0,
    activeToolCallIndex,
  );
};

import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

export const buildUncachedMessages = (
  staticPrompt: string,
  dynamic: string,
  history: BaseMessage[],
): BaseMessage[] => {
  const systemText = dynamic.length > 0 ? `${staticPrompt}\n\n${dynamic}` : staticPrompt;
  return [new SystemMessage(systemText), ...history];
};

/** Gemini forbids system_instruction alongside cachedContent — use HumanMessage for dynamic bits. */
export const buildCachedMessages = (
  dynamic: string,
  history: BaseMessage[],
): BaseMessage[] => [
  ...(dynamic.length > 0 ? [new HumanMessage(dynamic)] : []),
  ...history,
];

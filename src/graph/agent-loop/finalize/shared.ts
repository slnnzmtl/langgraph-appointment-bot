import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ClinicHandoffStatus } from "../../types.js";
import { extractMessageTextContent } from "../../../shared/message-content.js";
import { isModelFailureMessage } from "../../sub-agent-messages.js";

export const resolveHandoffStatus = (
  message: AIMessage,
  stepCount: number,
  maxSteps: number,
  agentMessages: BaseMessage[],
): ClinicHandoffStatus => {
  if (isModelFailureMessage(message)) {
    return "error";
  }

  if (stepCount >= maxSteps) {
    return "max_steps";
  }

  const responseText = extractMessageTextContent(message.content).trim();
  const toolCalls = message.tool_calls ?? [];

  if (responseText.length === 0 && toolCalls.length === 0) {
    return "empty";
  }

  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    const candidate = agentMessages[index];
    if (!(candidate instanceof ToolMessage)) {
      continue;
    }
    const body = extractMessageTextContent(candidate.content).trim();
    if (body.startsWith("Error:")) {
      return "error";
    }
    break;
  }

  return "ok";
};

import { DEFAULT_GEMINI_MODEL } from "@personal-assistant/llm-gemini";

import { getMessageHistoryMaxTokens } from "./shared/message-budget.js";

export interface AppConfig {
  googleApiKey: string;
  supervisorModel: string;
  agentModel: string;
  messageHistoryMaxTokens: number;
  /** SSE endpoint for EspoCRM MCP (e.g. http://espocrm-mcp-server:3000/sse). */
  espocrmMcpUrl: string;
  /** Injected into every create_meeting MCP call. */
  assignedUserId: string;
  /** Optional; required only when launching the Telegram bot. */
  telegramBotToken?: string;
}

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const loadConfig = (): AppConfig => {
  const defaultModel = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

  return {
    googleApiKey: getRequiredEnv("GOOGLE_API_KEY"),
    supervisorModel: process.env.SUPERVISOR_MODEL ?? defaultModel,
    agentModel: process.env.AGENT_MODEL ?? defaultModel,
    messageHistoryMaxTokens: getMessageHistoryMaxTokens(),
    espocrmMcpUrl: getRequiredEnv("ESPOCRM_MCP_URL"),
    assignedUserId: getRequiredEnv("ESPOCRM_ASSIGNED_USER_ID"),
    ...(process.env.TELEGRAM_BOT_TOKEN?.trim()
      ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN.trim() }
      : {}),
  };
};

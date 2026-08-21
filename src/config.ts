import { DEFAULT_GEMINI_MODEL } from "@personal-assistant/llm-gemini";

import { getMessageHistoryMaxTokens } from "./shared/message-budget.js";

export interface AppConfig {
  googleApiKey: string;
  supervisorModel: string;
  agentModel: string;
  messageHistoryMaxTokens: number;
  /** EspoCRM MCP origin for HTTP `/health` and `/tools` (e.g. http://espocrm-mcp-server:3000). */
  espocrmMcpUrl: string;
  /** Sent as the `espocrm_api_key` header on MCP HTTP calls. */
  espocrmApiKey: string;
  /** Injected into every create_meeting MCP call. */
  assignedUserId: string;
  /** Optional; required only when launching the Telegram bot. */
  telegramBotToken?: string;
  /** Optional; required with telegramBotToken to listen for tomorrow-reminder POSTs. */
  webhookSecret?: string;
  /** Explicit Gemini CachedContent for supervisor/agent prompts. Default on. */
  geminiContextCacheEnabled: boolean;
}

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const isGeminiContextCacheEnabled = (raw = process.env.GEMINI_CONTEXT_CACHE): boolean =>
  raw === undefined || (raw !== "0" && raw.toLowerCase() !== "false");

export const loadConfig = (): AppConfig => {
  const defaultModel = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

  return {
    googleApiKey: getRequiredEnv("GOOGLE_API_KEY"),
    supervisorModel: process.env.SUPERVISOR_MODEL ?? defaultModel,
    agentModel: process.env.AGENT_MODEL ?? defaultModel,
    messageHistoryMaxTokens: getMessageHistoryMaxTokens(),
    espocrmMcpUrl: getRequiredEnv("ESPOCRM_MCP_URL"),
    espocrmApiKey: getRequiredEnv("ESPOCRM_API_KEY"),
    assignedUserId: getRequiredEnv("ESPOCRM_ASSIGNED_USER_ID"),
    geminiContextCacheEnabled: isGeminiContextCacheEnabled(),
    ...(process.env.TELEGRAM_BOT_TOKEN?.trim()
      ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN.trim() }
      : {}),
    ...(process.env.WEBHOOK_SECRET?.trim()
      ? { webhookSecret: process.env.WEBHOOK_SECRET.trim() }
      : {}),
  };
};

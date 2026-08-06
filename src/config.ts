import path from "node:path";

import { DEFAULT_GEMINI_MODEL } from "@personal-assistant/llm-gemini";
import { getMessageHistoryMaxTokens } from "@personal-assistant/supervisor-framework";

export interface AppConfig {
  googleApiKey: string;
  supervisorModel: string;
  agentModel: string;
  runtimeAgentsFilePath: string;
  cronJobsFilePath: string;
  messageHistoryMaxTokens: number;
  espocrmMcpCommand: string;
  espocrmMcpArgs: string[];
  espocrmMcpCwd: string;
  espocrmUrl: string;
  espocrmApiKey: string;
  espocrmAuthMethod: string;
  espocrmSecretKey?: string;
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

const parseArgs = (raw: string | undefined, fallback: string[]): string[] => {
  if (!raw?.trim()) {
    return fallback;
  }
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
};

export const getDefaultRuntimeAgentsPath = (cwd = process.cwd()): string =>
  path.resolve(cwd, "data/runtime-agents.json");

export const getDefaultCronJobsPath = (cwd = process.cwd()): string =>
  path.resolve(cwd, "data/cron-jobs.json");

export const getDefaultEspocrmMcpCwd = (): string => "/root/espocrm-mcp";

export const loadConfig = (): AppConfig => {
  const defaultModel = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

  return {
    googleApiKey: getRequiredEnv("GOOGLE_API_KEY"),
    supervisorModel: process.env.SUPERVISOR_MODEL ?? defaultModel,
    agentModel: process.env.AGENT_MODEL ?? defaultModel,
    runtimeAgentsFilePath: process.env.RUNTIME_AGENTS_FILE_PATH ?? getDefaultRuntimeAgentsPath(),
    cronJobsFilePath: process.env.CRON_JOBS_FILE_PATH ?? getDefaultCronJobsPath(),
    messageHistoryMaxTokens: getMessageHistoryMaxTokens(),
    espocrmMcpCommand: process.env.ESPOCRM_MCP_COMMAND ?? "node",
    espocrmMcpArgs: parseArgs(process.env.ESPOCRM_MCP_ARGS, ["build/index.js"]),
    espocrmMcpCwd: process.env.ESPOCRM_MCP_CWD ?? getDefaultEspocrmMcpCwd(),
    espocrmUrl: getRequiredEnv("ESPOCRM_URL"),
    espocrmApiKey: getRequiredEnv("ESPOCRM_API_KEY"),
    espocrmAuthMethod: process.env.ESPOCRM_AUTH_METHOD ?? "apikey",
    ...(process.env.ESPOCRM_SECRET_KEY
      ? { espocrmSecretKey: process.env.ESPOCRM_SECRET_KEY }
      : {}),
    assignedUserId: getRequiredEnv("ESPOCRM_ASSIGNED_USER_ID"),
    ...(process.env.TELEGRAM_BOT_TOKEN?.trim()
      ? { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN.trim() }
      : {}),
  };
};

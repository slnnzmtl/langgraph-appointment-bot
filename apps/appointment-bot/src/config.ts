import path from "node:path";

import { getMessageHistoryMaxTokens } from "@personal-assistant/supervisor-framework";

import { DEFAULT_GEMINI_MODEL } from "./llm/gemini-connector.js";

export interface AppConfig {
  googleApiKey: string;
  supervisorModel: string;
  agentModel: string;
  runtimeAgentsFilePath: string;
  cronJobsFilePath: string;
  messageHistoryMaxTokens: number;
}

const getRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const getDefaultRuntimeAgentsPath = (cwd = process.cwd()): string =>
  path.resolve(cwd, "data/runtime-agents.json");

export const getDefaultCronJobsPath = (cwd = process.cwd()): string =>
  path.resolve(cwd, "data/cron-jobs.json");

export const loadConfig = (): AppConfig => {
  const defaultModel = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

  return {
    googleApiKey: getRequiredEnv("GOOGLE_API_KEY"),
    supervisorModel: process.env.SUPERVISOR_MODEL ?? defaultModel,
    agentModel: process.env.AGENT_MODEL ?? defaultModel,
    runtimeAgentsFilePath: process.env.RUNTIME_AGENTS_FILE_PATH ?? getDefaultRuntimeAgentsPath(),
    cronJobsFilePath: process.env.CRON_JOBS_FILE_PATH ?? getDefaultCronJobsPath(),
    messageHistoryMaxTokens: getMessageHistoryMaxTokens(),
  };
};

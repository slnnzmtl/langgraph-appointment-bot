import {
  buildDefaultRuntimeExecution,
  createCapabilityCatalog,
  createSupervisorRuntime,
  NONE_CAPABILITY_PROVIDER,
  seedAgentsIfMissing,
  type SupervisorRuntime,
} from "@personal-assistant/supervisor-framework";

import type { AppConfig } from "../config.js";
import { GeminiConnector } from "../llm/gemini-connector.js";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor.js";
import { bookingAgentInput, faqAgentInput } from "./agents.js";

/** Phase 1: empty capability deps / adapters. */
export type ClinicRuntime = SupervisorRuntime<
  AppConfig,
  Record<string, unknown>,
  Record<string, never>
>;

export const createClinicPackRuntime = async (config: AppConfig): Promise<ClinicRuntime> =>
  createSupervisorRuntime<AppConfig, Record<string, unknown>, Record<string, never>>({
    config,
    capabilityCatalog: createCapabilityCatalog([NONE_CAPABILITY_PROVIDER]),
    supervisorLlm: new GeminiConnector(config.googleApiKey, config.supervisorModel),
    loadSupervisorPrompt: () => SUPERVISOR_PROMPT,
    seedAgents: seedAgentsIfMissing([faqAgentInput, bookingAgentInput]),
    buildRuntimeExecution: (_agents, _skillCatalog, ctx) =>
      buildDefaultRuntimeExecution(ctx.capabilityCatalog),
    buildModels: () => ({
      generic: new GeminiConnector(config.googleApiKey, config.agentModel).getModel(),
    }),
    buildCapabilityDeps: () => ({}),
  });

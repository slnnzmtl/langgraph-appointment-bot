import {
  buildDefaultRuntimeExecution,
  createSupervisorRuntime,
  seedAgentsIfMissing,
  type SupervisorRuntime,
} from "@personal-assistant/supervisor-framework";

import type { AppConfig } from "../config.js";
import { GeminiConnector } from "../llm/gemini-connector.js";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor.js";
import { bookingAgentInput, faqAgentInput } from "./agents.js";
import { closeClinicAdapters, setupClinicAdapters, type ClinicAdapters } from "./clinic-adapters.js";
import { buildClinicCapabilityProviders } from "./clinic-capability-providers.js";

export type ClinicRuntime = SupervisorRuntime<AppConfig, Record<string, unknown>, ClinicAdapters>;

export const createClinicPackRuntime = async (config: AppConfig): Promise<ClinicRuntime> =>
  createSupervisorRuntime<AppConfig, Record<string, unknown>, ClinicAdapters>(
    {
      config,
      setupAdapters: setupClinicAdapters,
      buildCapabilityProviders: (ctx) =>
        buildClinicCapabilityProviders({
          config: ctx.config,
          adapters: ctx.adapters,
        }),
      supervisorLlm: new GeminiConnector(config.googleApiKey, config.supervisorModel),
      loadSupervisorPrompt: () => SUPERVISOR_PROMPT,
      seedAgents: seedAgentsIfMissing([faqAgentInput, bookingAgentInput]),
      buildRuntimeExecution: (_agents, _skillCatalog, ctx) =>
        buildDefaultRuntimeExecution(ctx.capabilityCatalog),
      buildModels: () => ({
        generic: new GeminiConnector(config.googleApiKey, config.agentModel).getModel(),
      }),
      buildCapabilityDeps: () => ({}),
    },
    {
      onBeforeRecompile: closeClinicAdapters,
      onShutdownAdapters: closeClinicAdapters,
    },
  );

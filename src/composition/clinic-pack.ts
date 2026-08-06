import {
  createCachedGeminiModel,
  createGeminiContextCacheManager,
  GeminiConnector,
  isGeminiContextCacheEnabled,
} from "@personal-assistant/llm-gemini";
import {
  createAgentPolicy,
  createRuntimeShellHooks,
  createSupervisorRuntime,
  resolveAgentTools,
  seedAgentsIfMissing,
  type SupervisorRuntime,
} from "@personal-assistant/supervisor-framework";

import type { AppConfig } from "../config.js";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor.js";
import { bookingAgentInput, faqAgentInput } from "./agents.js";
import { closeClinicAdapters, setupClinicAdapters, type ClinicAdapters } from "./clinic-adapters.js";
import { buildClinicCapabilityProviders } from "./clinic-capability-providers.js";
import {
  buildClinicSupervisorDynamicContext,
  clinicShellFormatters,
} from "./clinic-datetime.js";

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
      buildRuntimeExecution: (_agents, _skillCatalog, ctx) => ({
        loadPromptByKey: () => "",
        buildSupervisorDynamicContext: buildClinicSupervisorDynamicContext,
        runtimeAgentPolicy: createAgentPolicy(
          {
            resolveTools: (definition, deps) =>
              resolveAgentTools(definition, ctx.capabilityCatalog, deps, {
                includeReadSkill: false,
              }),
            createHooks: (_deps, options) =>
              createRuntimeShellHooks(options.shellFormatters!),
          },
          { shellFormatters: clinicShellFormatters },
        ),
        contextCache: {
          cacheManager: createGeminiContextCacheManager(
            config.googleApiKey,
            isGeminiContextCacheEnabled(),
          ),
          apiKey: config.googleApiKey,
          createCachedModel: createCachedGeminiModel,
          resolveRuntimeModelName: () => config.agentModel,
          supervisorModelName: config.supervisorModel,
        },
      }),
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

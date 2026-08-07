import {
  createGeminiContextCacheManager,
  GeminiConnector,
  isGeminiContextCacheEnabled,
} from "@personal-assistant/llm-gemini";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { AppConfig } from "../config.js";
import { compileClinicGraph } from "../graph/compile.js";
import {
  BOOKING_AGENT_ID,
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../graph/types.js";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor.js";
import { createBookingTools, createReadTools } from "../tools/clinic-tools.js";
import { clinicAgents } from "./agents.js";
import { closeClinicAdapters, setupClinicAdapters, type ClinicAdapters } from "./clinic-adapters.js";
import {
  buildClinicSupervisorDynamicContext,
  formatKyivSystemMetadata,
} from "./clinic-datetime.js";

export type ClinicBootstrap = {
  config: AppConfig;
  adapters: ClinicAdapters;
  agents: ClinicAgentDefinition[];
  agentTools: Record<string, StructuredToolInterface[]>;
};

export type ClinicRuntime = {
  getGraph: () => ReturnType<typeof compileClinicGraph>["graph"];
  getBootstrap: () => ClinicBootstrap;
  getCheckpointer: () => BaseCheckpointSaver;
  shutdownAdapters: () => Promise<void>;
};

/** Build FAQ/booking tool lists. callTool is read via adapters each invoke so smoke can wrap it. */
export const buildClinicAgentTools = (
  config: AppConfig,
  adapters: ClinicAdapters,
): Record<string, StructuredToolInterface[]> => {
  const callTool: typeof adapters.callTool = (name, args) => adapters.callTool(name, args);
  const readTools = createReadTools({ callTool });
  const bookingTools = createBookingTools({
    callTool,
    assignedUserId: config.assignedUserId,
  });

  return {
    [FAQ_AGENT_ID]: readTools,
    [BOOKING_AGENT_ID]: [...readTools, ...bookingTools],
  };
};

export const createClinicRuntime = async (config: AppConfig): Promise<ClinicRuntime> => {
  const adapters = await setupClinicAdapters(config);
  const agentTools = buildClinicAgentTools(config, adapters);

  const supervisorLlm = new GeminiConnector(config.googleApiKey, config.supervisorModel);
  const agentModel = new GeminiConnector(config.googleApiKey, config.agentModel).getModel();
  const contextCache = {
    manager: createGeminiContextCacheManager(
      config.googleApiKey,
      isGeminiContextCacheEnabled(),
    ),
    apiKey: config.googleApiKey,
    modelName: config.supervisorModel,
    displayName: "clinic-supervisor",
  };

  const { graph, checkpointer } = compileClinicGraph({
    agents: clinicAgents,
    agentTools,
    agentModel,
    supervisorLlm,
    loadSupervisorPrompt: () => SUPERVISOR_PROMPT,
    buildSupervisorDynamicContext: buildClinicSupervisorDynamicContext,
    formatSystemMetadata: formatKyivSystemMetadata,
    messageHistoryMaxTokens: config.messageHistoryMaxTokens,
    contextCache,
  });

  const bootstrap: ClinicBootstrap = {
    config,
    adapters,
    agents: clinicAgents,
    agentTools,
  };

  return {
    getGraph: () => graph,
    getBootstrap: () => bootstrap,
    getCheckpointer: () => checkpointer,
    shutdownAdapters: () => closeClinicAdapters(adapters),
  };
};

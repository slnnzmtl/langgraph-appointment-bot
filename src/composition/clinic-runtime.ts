import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { AppConfig } from "../config.js";
import { compileClinicGraph } from "../graph/compile.js";
import type { ClinicAgentDefinition } from "../graph/types.js";
import { SUPERVISOR_PROMPT } from "../prompts/supervisor.js";
import { clinicAgents } from "./agents.js";
import { buildClinicAgentTools } from "./clinic-agent-tools.js";
import { closeClinicAdapters, setupClinicAdapters, type ClinicAdapters } from "./clinic-adapters.js";
import {
  buildClinicSupervisorDynamicContext,
  formatKyivSystemMetadata,
} from "./clinic-datetime.js";
import { createClinicLlmStack } from "./clinic-llm.js";

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

export { buildClinicAgentTools } from "./clinic-agent-tools.js";

export const createClinicRuntime = async (config: AppConfig): Promise<ClinicRuntime> => {
  const adapters = await setupClinicAdapters(config);
  const agentTools = buildClinicAgentTools(config, adapters);
  const { supervisorLlm, agentModel, agentModelName, contextCache } =
    createClinicLlmStack(config);

  const { graph, checkpointer } = compileClinicGraph({
    agents: clinicAgents,
    agentTools,
    agentModel,
    agentModelName,
    supervisorLlm,
    loadSupervisorPrompt: () => SUPERVISOR_PROMPT,
    buildSupervisorDynamicContext: buildClinicSupervisorDynamicContext,
    formatSystemMetadata: formatKyivSystemMetadata,
    messageHistoryMaxTokens: config.messageHistoryMaxTokens,
    contextCache,
    bookingPrefetchCallTool: (name, args) => adapters.callTool(name, args),
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

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import type { AppConfig } from "../config.js";
import { compileClinicGraph } from "../graph/compile.js";
import type { ClinicAgentId, ClinicSpecialists } from "../graph/types.js";
import { clinicSpecialists } from "./agents.js";
import { buildClinicAgentTools } from "./clinic-agent-tools.js";
import { setupClinicAdapters, type ClinicAdapters } from "./clinic-adapters.js";
import {
  formatKyivSystemMetadata,
} from "./clinic-datetime.js";
import { createClinicLlmStack } from "./clinic-llm.js";
import { configurePendingConfirmStore } from "../tools/meeting-confirm.js";

export type ClinicBootstrap = {
  config: AppConfig;
  adapters: ClinicAdapters;
  specialists: ClinicSpecialists;
  agentTools: Record<ClinicAgentId, StructuredToolInterface[]>;
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

  mkdirSync(dirname(config.checkpointDbPath), { recursive: true });
  configurePendingConfirmStore(config.checkpointDbPath);
  const checkpointer = SqliteSaver.fromConnString(config.checkpointDbPath);

  const { graph } = compileClinicGraph({
    specialists: clinicSpecialists,
    agentTools,
    agentModel,
    agentModelName,
    supervisorLlm,
    formatSystemMetadata: formatKyivSystemMetadata,
    messageHistoryMaxTokens: config.messageHistoryMaxTokens,
    contextCache,
    bookingPrefetchCallTool: (name, args) => adapters.callTool(name, args),
    checkpointer,
    assignedUserId: config.assignedUserId,
  });

  const bootstrap: ClinicBootstrap = {
    config,
    adapters,
    specialists: clinicSpecialists,
    agentTools,
  };

  return {
    getGraph: () => graph,
    getBootstrap: () => bootstrap,
    getCheckpointer: () => checkpointer,
    shutdownAdapters: () => adapters.shutdown(),
  };
};

/** Graph node name helpers — kept separate to avoid circular imports. */

export const prepareNodeName = (agentId: string): string => `${agentId}__prepare`;

export const commandPrepareNodeName = (agentId: string): string => `${agentId}__command_prepare`;

export const llmNodeName = (agentId: string): string => `${agentId}__llm`;

export const toolsNodeName = (agentId: string): string => `${agentId}__tools`;

export const finalizeNodeName = (agentId: string): string => `${agentId}__finalize`;

export const mutationFinalizeNodeName = (agentId: string): string => `${agentId}__mutation_finalize`;

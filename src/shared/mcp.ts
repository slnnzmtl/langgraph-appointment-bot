export type McpCallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { AppConfig } from "../config.js";
import type { McpCallTool } from "../shared/mcp.js";

export type { McpCallTool };

export type ClinicAdapters = {
  callTool: McpCallTool;
  close: () => Promise<void>;
};

type TextContent = {
  type: string;
  text?: string;
};

const parseToolResponse = (response: unknown): unknown => {
  const content = (response as { content?: TextContent[] }).content;
  const text = content?.find((item) => item.type === "text")?.text;

  if (text === undefined) {
    return response;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const buildChildEnv = (config: AppConfig): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.TRANSPORT_MODE = "stdio";
  env.ESPOCRM_URL = config.espocrmUrl;
  env.ESPOCRM_API_KEY = config.espocrmApiKey;
  env.ESPOCRM_AUTH_METHOD = config.espocrmAuthMethod;
  if (config.espocrmSecretKey) {
    env.ESPOCRM_SECRET_KEY = config.espocrmSecretKey;
  }

  return env;
};

export const setupClinicAdapters = async (config: AppConfig): Promise<ClinicAdapters> => {
  const transport = new StdioClientTransport({
    command: config.espocrmMcpCommand,
    args: config.espocrmMcpArgs,
    cwd: config.espocrmMcpCwd,
    env: buildChildEnv(config),
  });

  const client = new Client(
    { name: "clinic-espocrm-mcp", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    callTool: async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      if ((response as { isError?: boolean }).isError) {
        const text = parseToolResponse(response);
        throw new Error(
          typeof text === "string" ? text : `MCP tool "${name}" failed: ${JSON.stringify(text)}`,
        );
      }
      return parseToolResponse(response);
    },
    close: async () => {
      await client.close();
    },
  };
};

export const closeClinicAdapters = async (adapters: ClinicAdapters): Promise<void> => {
  await adapters.close().catch(() => undefined);
};

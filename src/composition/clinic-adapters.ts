import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import type { AppConfig } from "../config.js";
import type { McpCallTool } from "../shared/mcp.js";
import { withNormalizedClinicPhones } from "../shared/phone.js";

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

export const setupClinicAdapters = async (config: AppConfig): Promise<ClinicAdapters> => {
  const transport = new SSEClientTransport(new URL(config.espocrmMcpUrl));

  const client = new Client(
    { name: "clinic-espocrm-mcp", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    callTool: withNormalizedClinicPhones(async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      if ((response as { isError?: boolean }).isError) {
        const text = parseToolResponse(response);
        throw new Error(
          typeof text === "string" ? text : `MCP tool "${name}" failed: ${JSON.stringify(text)}`,
        );
      }
      return parseToolResponse(response);
    }),
    close: async () => {
      await client.close();
    },
  };
};

export const closeClinicAdapters = async (adapters: ClinicAdapters): Promise<void> => {
  await adapters.close().catch(() => undefined);
};

import type { AppConfig } from "../config.js";
import type { McpCallTool } from "../shared/mcp.js";
import { withNormalizedClinicPhones } from "../shared/phone.js";

export type { McpCallTool };

export type ClinicAdapters = {
  callTool: McpCallTool;
  shutdown: () => Promise<void>;
};

type TextContent = {
  type: string;
  text?: string;
};

/** Align with EspoCRM MCP `REQUEST_TIMEOUT` (default 30s). */
const MCP_HTTP_TIMEOUT_MS = 30_000;

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

const httpErrorMessage = (name: string, status: number, body: unknown): string => {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const message = (nested as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }
  return `MCP tool "${name}" failed (HTTP ${status})`;
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const setupClinicAdapters = async (config: AppConfig): Promise<ClinicAdapters> => {
  const origin = new URL(config.espocrmMcpUrl).origin;
  const health = await fetch(`${origin}/health`, {
    signal: AbortSignal.timeout(MCP_HTTP_TIMEOUT_MS),
  });
  if (!health.ok) {
    throw new Error(`EspoCRM MCP health check failed (HTTP ${health.status})`);
  }

  const inflight = new Set<AbortController>();
  let closed = false;

  const callTool: McpCallTool = withNormalizedClinicPhones(async (name, args) => {
    if (closed) {
      throw new Error("EspoCRM MCP adapters are shut down");
    }
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), MCP_HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${origin}/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch (error) {
      if (closed) {
        throw new Error("EspoCRM MCP adapters are shut down");
      }
      const aborted =
        (error instanceof Error && error.name === "TimeoutError") ||
        (error instanceof Error && error.name === "AbortError") ||
        controller.signal.aborted;
      if (aborted) {
        throw new Error(`MCP tool "${name}" timed out after ${MCP_HTTP_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      inflight.delete(controller);
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(httpErrorMessage(name, response.status, body));
    }
    return parseToolResponse(body);
  });

  return {
    callTool,
    shutdown: async () => {
      closed = true;
      for (const controller of inflight) {
        controller.abort();
      }
      inflight.clear();
    },
  };
};

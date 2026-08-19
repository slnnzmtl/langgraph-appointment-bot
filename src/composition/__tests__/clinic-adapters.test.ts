import { afterEach, describe, expect, it, vi } from "vitest";

import { setupClinicAdapters } from "../clinic-adapters.js";

const adapterConfig = {
  googleApiKey: "key",
  supervisorModel: "model",
  agentModel: "model",
  messageHistoryMaxTokens: 6000,
  assignedUserId: "user-1",
  geminiContextCacheEnabled: false,
} as const;

describe("clinic-adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts tool calls to /tools and parses text content", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
      }
      expect(url).toBe("http://127.0.0.1:3000/tools/search_entity");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ entityType: "cService", limit: 50 });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ total: 1, list: [{ id: "svc-1" }] }) }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapters = await setupClinicAdapters({
      ...adapterConfig,
      espocrmMcpUrl: "http://127.0.0.1:3000",
    });

    await expect(adapters.callTool("search_entity", { entityType: "cService", limit: 50 })).resolves.toEqual({
      total: 1,
      list: [{ id: "svc-1" }],
    });
  });

  it("throws the MCP error message on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "http://espocrm-mcp-server:3000/health") {
          return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
        }
        expect(url).toBe("http://espocrm-mcp-server:3000/tools/search_entity");
        return new Response(
          JSON.stringify({
            error: { type: "timeout", message: "Upstream request timed out", status: 504 },
          }),
          { status: 504 },
        );
      }),
    );

    const adapters = await setupClinicAdapters({
      ...adapterConfig,
      espocrmMcpUrl: "http://espocrm-mcp-server:3000",
    });

    await expect(adapters.callTool("search_entity", { entityType: "cService" })).rejects.toThrow(
      "Upstream request timed out",
    );
  });

  it("throws when MCP health check fails and does not call tools", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setupClinicAdapters({
        ...adapterConfig,
        espocrmMcpUrl: "http://127.0.0.1:3000",
      }),
    ).rejects.toThrow("EspoCRM MCP health check failed (HTTP 503)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/health");
  });

  it("maps fetch abort to a tool timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
        }
        const error = new Error("The operation was aborted");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    const adapters = await setupClinicAdapters({
      ...adapterConfig,
      espocrmMcpUrl: "http://127.0.0.1:3000",
    });

    await expect(adapters.callTool("search_entity", { entityType: "cService" })).rejects.toThrow(
      'MCP tool "search_entity" timed out after 30000ms',
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { GoogleAICacheManager } from "@google/generative-ai/server";
import { z } from "zod";

import {
  buildCacheSeedContents,
  createCachedGeminiModel,
  createGeminiContextCacheManager,
  fingerprintContextCacheSpec,
  isGeminiContextCacheEnabled,
  parseCacheTooSmallShortfall,
  resolveCacheMinTokens,
} from "../../src/gemini-context-cache.js";

const sampleTool = tool(async () => "ok", {
  name: "list_skills",
  description: "List skills",
  schema: z.object({
    module: z.string(),
  }),
});

const sampleSpec = {
  modelName: "gemini-2.5-flash-lite",
  staticSystemInstruction: "static prompt",
  tools: [sampleTool],
  displayName: "configuration-agent",
};

const seedTextLength = (
  contents: ReturnType<typeof buildCacheSeedContents>,
): number =>
  contents
    .flatMap((content) => content.parts ?? [])
    .reduce((sum, part) => sum + ("text" in part ? part.text.length : 0), 0);

const otherTool = tool(async () => "ok", {
  name: "list_cron_jobs",
  description: "List cron jobs",
  schema: z.object({}),
});

describe("gemini context cache helpers", () => {
  it("fingerprintContextCacheSpec is stable for the same spec", () => {
    const spec = {
      modelName: "gemini-2.5-flash",
      staticSystemInstruction: "static prompt",
      tools: [sampleTool],
      displayName: "configuration-agent",
    };

    expect(fingerprintContextCacheSpec(spec)).toBe(fingerprintContextCacheSpec(spec));
  });

  it("fingerprintContextCacheSpec differs when tools differ", () => {
    const base = {
      modelName: "gemini-2.5-flash",
      staticSystemInstruction: "static prompt",
      displayName: "agent",
    };

    expect(
      fingerprintContextCacheSpec({ ...base, tools: [sampleTool] }),
    ).not.toBe(
      fingerprintContextCacheSpec({ ...base, tools: [otherTool] }),
    );
  });

  it("fingerprintContextCacheSpec differs when tool schemas differ", () => {
    const sameNameToolA = tool(async () => "ok", {
      name: "list_items",
      description: "List items",
      schema: z.object({ module: z.string() }),
    });
    const sameNameToolB = tool(async () => "ok", {
      name: "list_items",
      description: "List items",
      schema: z.object({ module: z.string(), limit: z.number() }),
    });

    const base = {
      modelName: "gemini-2.5-flash",
      staticSystemInstruction: "static prompt",
      displayName: "agent",
    };

    expect(
      fingerprintContextCacheSpec({ ...base, tools: [sameNameToolA] }),
    ).not.toBe(
      fingerprintContextCacheSpec({ ...base, tools: [sameNameToolB] }),
    );
  });

  it("createGeminiContextCacheManager returns null when disabled", async () => {
    const manager = createGeminiContextCacheManager("test-key", false);
    const handle = await manager.getOrCreate({
      modelName: "gemini-2.5-flash",
      staticSystemInstruction: "static prompt",
      tools: [sampleTool],
      displayName: "configuration-agent",
    });

    expect(handle).toBeNull();
  });

  it("isGeminiContextCacheEnabled defaults to enabled", () => {
    const previous = process.env.GEMINI_CONTEXT_CACHE;
    delete process.env.GEMINI_CONTEXT_CACHE;

    expect(isGeminiContextCacheEnabled()).toBe(true);

    process.env.GEMINI_CONTEXT_CACHE = previous;
  });

  it("resolveCacheMinTokens matches Gemini's per-model minimums", () => {
    expect(resolveCacheMinTokens("gemini-2.5-flash-lite")).toBe(1024);
    expect(resolveCacheMinTokens("models/gemini-2.5-flash-lite")).toBe(1024);
    expect(resolveCacheMinTokens("gemini-2.5-flash")).toBe(2048);
    expect(resolveCacheMinTokens("models/gemini-2.5-flash")).toBe(2048);
    expect(resolveCacheMinTokens("gemini-3-pro")).toBe(4096);
    expect(resolveCacheMinTokens("models/gemini-3-pro")).toBe(4096);
    expect(resolveCacheMinTokens("some-unknown-model")).toBe(2048);
  });

  it("resolveCacheMinTokens prefers gemini-3 over flash family names", () => {
    expect(resolveCacheMinTokens("gemini-3-flash")).toBe(4096);
    expect(resolveCacheMinTokens("gemini-3-flash-lite")).toBe(4096);
  });

  it("parseCacheTooSmallShortfall parses reordered error fields", () => {
    const shortfall = parseCacheTooSmallShortfall(
      new Error(
        "Cached content is too small. min_total_token_count=2048 total_token_count=1295",
      ),
    );

    expect(shortfall).toBe(753);
  });

  it("parseCacheTooSmallShortfall reads nested error causes", () => {
    const shortfall = parseCacheTooSmallShortfall(
      new Error("Request failed", {
        cause: new Error(
          "Cached content is too small. total_token_count=990, min_total_token_count=1024",
        ),
      }),
    );

    expect(shortfall).toBe(34);
  });

  it("parseCacheTooSmallShortfall returns null for unrelated errors", () => {
    expect(parseCacheTooSmallShortfall(new Error("500 Internal Server Error"))).toBeNull();
  });

  it("buildCacheSeedContents pads a short instruction to reach the model minimum", () => {
    const spec = {
      modelName: "gemini-2.5-flash-lite",
      staticSystemInstruction: "short prompt",
      tools: [],
      displayName: "agent",
    };

    const contents = buildCacheSeedContents(spec, "");
    const seedTokenEstimate = Math.ceil(seedTextLength(contents) / 4);
    const fixedEstimate = Math.ceil(spec.staticSystemInstruction.length / 4);

    expect(seedTokenEstimate + fixedEstimate).toBeGreaterThan(1024);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
    expect(String(contents[0]?.parts?.[0] && "text" in contents[0].parts[0] ? contents[0].parts[0].text : "")).toContain(
      "<cache_bootstrap",
    );
  });

  it("buildCacheSeedContents grows monotonically with extraDeficitTokens", () => {
    const spec = {
      modelName: "gemini-2.5-flash-lite",
      staticSystemInstruction: "short prompt",
      tools: [],
      displayName: "agent",
    };

    const baseLength = seedTextLength(buildCacheSeedContents(spec, "", 0));
    const paddedLength = seedTextLength(buildCacheSeedContents(spec, "", 100));

    expect(paddedLength).toBeGreaterThan(baseLength);
  });

  it("buildCacheSeedContents pads more for models with a higher minimum", () => {
    const baseSpec = {
      staticSystemInstruction: "short prompt",
      tools: [],
      displayName: "agent",
    };

    const liteContents = buildCacheSeedContents(
      { ...baseSpec, modelName: "gemini-2.5-flash-lite" },
      "",
    );
    const flashContents = buildCacheSeedContents(
      { ...baseSpec, modelName: "gemini-2.5-flash" },
      "",
    );

    const seedLength = (contents: ReturnType<typeof buildCacheSeedContents>) =>
      seedTextLength(contents);

    expect(seedLength(flashContents)).toBeGreaterThan(seedLength(liteContents));
  });

  it("createGeminiContextCacheManager retries once when the create response is too small", async () => {
    const createRequests: Array<{ contents?: unknown }> = [];
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async (request) => {
        callCount += 1;
        createRequests.push(request);
        if (callCount === 1) {
          throw new Error(
            "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/cachedContents: [400 Bad Request] Cached content is too small. total_token_count=990, min_total_token_count=1024",
          );
        }

        return {
          name: "cachedContents/retry-success",
          model: "models/gemini-2.5-flash-lite",
          systemInstruction: request.systemInstruction,
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const handle = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(2);
      expect(seedTextLength(createRequests[1]?.contents as ReturnType<typeof buildCacheSeedContents>))
        .toBeGreaterThan(
          seedTextLength(createRequests[0]?.contents as ReturnType<typeof buildCacheSeedContents>),
        );
      expect(handle).toEqual({
        cacheName: "cachedContents/retry-success",
        model: "models/gemini-2.5-flash-lite",
      });
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager retries with real padding even when the initial estimate overshoots the model minimum", async () => {
    const oversizedStaticInstruction = "static prompt ".repeat(3000);
    const createRequests: Array<{ contents?: unknown }> = [];
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async (request) => {
        callCount += 1;
        createRequests.push(request);
        if (callCount === 1) {
          throw new Error(
            "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/cachedContents: [400 Bad Request] Cached content is too small. total_token_count=1697, min_total_token_count=2048",
          );
        }

        return {
          name: "cachedContents/retry-success",
          model: "models/gemini-2.5-flash",
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const handle = await manager.getOrCreate({
        modelName: "gemini-2.5-flash",
        staticSystemInstruction: oversizedStaticInstruction,
        tools: [],
        displayName: "obsidian",
      });

      expect(callCount).toBe(2);
      expect(seedTextLength(createRequests[1]?.contents as ReturnType<typeof buildCacheSeedContents>))
        .toBeGreaterThan(
          seedTextLength(createRequests[0]?.contents as ReturnType<typeof buildCacheSeedContents>),
        );
      expect(handle).toEqual({
        cacheName: "cachedContents/retry-success",
        model: "models/gemini-2.5-flash",
      });
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager falls back after two consecutive too-small errors", async () => {
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        throw new Error(
          "Cached content is too small. total_token_count=990, min_total_token_count=1024",
        );
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const handle = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(2);
      expect(handle).toBeNull();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager reuses an in-memory cache for identical specs", async () => {
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        return {
          name: "cachedContents/reused",
          model: "models/gemini-2.5-flash-lite",
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const first = await manager.getOrCreate(sampleSpec);
      const second = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(1);
      expect(second).toEqual(first);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager recreates when expireTime is past skew", async () => {
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        return {
          name: `cachedContents/expired-${callCount}`,
          model: "models/gemini-2.5-flash-lite",
          // Already inside the 60s refresh skew window.
          expireTime: new Date(Date.now() + 30_000).toISOString(),
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const first = await manager.getOrCreate(sampleSpec);
      const second = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(2);
      expect(second?.cacheName).toBe("cachedContents/expired-2");
      expect(second?.cacheName).not.toBe(first?.cacheName);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager invalidate drops a handle for recreation", async () => {
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        return {
          name: `cachedContents/inv-${callCount}`,
          model: "models/gemini-2.5-flash-lite",
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const first = await manager.getOrCreate(sampleSpec);
      expect(first?.cacheName).toBe("cachedContents/inv-1");

      manager.invalidate("cachedContents/inv-1");
      const second = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(2);
      expect(second?.cacheName).toBe("cachedContents/inv-2");
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager does not store a create that loses an invalidate race", async () => {
    let callCount = 0;
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        if (callCount === 2) {
          await createGate;
        }
        return {
          name: `cachedContents/race-${callCount}`,
          model: "models/gemini-2.5-flash-lite",
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const seed = await manager.getOrCreate(sampleSpec);
      expect(seed?.cacheName).toBe("cachedContents/race-1");

      manager.invalidate("cachedContents/race-1");
      const inFlight = manager.getOrCreate(sampleSpec);
      await Promise.resolve();
      expect(callCount).toBe(2);

      // Invalidate the old name while recreate is still in flight.
      manager.invalidate("cachedContents/race-1");
      releaseCreate?.();

      const raced = await inFlight;
      expect(raced?.cacheName).toBe("cachedContents/race-2");

      // Because the in-flight create lost the generation race, it was not stored.
      const after = await manager.getOrCreate(sampleSpec);
      expect(callCount).toBe(3);
      expect(after?.cacheName).toBe("cachedContents/race-3");
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager dedupes concurrent getOrCreate calls", async () => {
    let callCount = 0;
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        await createGate;
        return {
          name: "cachedContents/concurrent",
          model: "models/gemini-2.5-flash-lite",
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        } as never;
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const first = manager.getOrCreate(sampleSpec);
      const second = manager.getOrCreate(sampleSpec);

      await Promise.resolve();
      expect(callCount).toBe(1);

      releaseCreate?.();
      const [firstHandle, secondHandle] = await Promise.all([first, second]);

      expect(firstHandle).toEqual(secondHandle);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createGeminiContextCacheManager falls back without retrying on non-size errors", async () => {
    let callCount = 0;
    const createSpy = vi
      .spyOn(GoogleAICacheManager.prototype, "create")
      .mockImplementation(async () => {
        callCount += 1;
        throw new Error("[GoogleGenerativeAI Error]: 500 Internal Server Error");
      });

    try {
      const manager = createGeminiContextCacheManager("test-key", true);
      const handle = await manager.getOrCreate(sampleSpec);

      expect(callCount).toBe(1);
      expect(handle).toBeNull();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("createCachedGeminiModel passes name and model to useCachedContent", () => {
    const spy = vi
      .spyOn(ChatGoogleGenerativeAI.prototype, "useCachedContent")
      .mockImplementation(() => undefined);

    try {
      createCachedGeminiModel("test-key", "gemini-2.5-flash", {
        cacheName: "cachedContents/abc",
        model: "models/gemini-2.5-flash",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "cachedContents/abc",
          model: "models/gemini-2.5-flash",
        }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

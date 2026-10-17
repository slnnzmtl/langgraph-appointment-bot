import { afterEach, describe, expect, it, vi } from "vitest";

const startObservation = vi.fn();
const forceFlush = vi.fn(async () => undefined);
const startActiveObservation = vi.fn(
  (_name: string, fn: (span: unknown) => unknown) => fn({}),
);
const propagateAttributes = vi.fn((_attrs: unknown, fn: () => unknown) => fn());
const setActiveTraceIO = vi.fn();

vi.mock("@langfuse/tracing", () => ({
  propagateAttributes: (...args: unknown[]) =>
    (propagateAttributes as (...a: unknown[]) => unknown)(...args),
  startActiveObservation: (...args: unknown[]) =>
    (startActiveObservation as (...a: unknown[]) => unknown)(...args),
  setActiveTraceIO: (...args: unknown[]) => setActiveTraceIO(...args),
  startObservation: (...args: unknown[]) => startObservation(...args),
}));

vi.mock("@langfuse/langchain", () => ({
  CallbackHandler: class {
    name = "langfuse";
  },
}));

vi.mock("@langfuse/otel", () => ({
  LangfuseSpanProcessor: class {
    forceFlush = forceFlush;
    shutdown = async () => undefined;
  },
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    register() {
      return undefined;
    }
    shutdown = async () => undefined;
  },
}));

const enableLangfuseEnv = (): void => {
  process.env.LANGFUSE_TRACING = "true";
  process.env.LANGFUSE_PUBLIC_KEY = "pk";
  process.env.LANGFUSE_SECRET_KEY = "sk";
  process.env.LANGFUSE_BASE_URL = "http://langfuse-web:3000";
};

describe("emitLangfuseEvent / flushLangfuseTracing / withClinicTurn", () => {
  afterEach(async () => {
    vi.resetModules();
    startObservation.mockReset();
    forceFlush.mockReset();
    forceFlush.mockImplementation(async () => undefined);
    startActiveObservation.mockReset();
    startActiveObservation.mockImplementation(
      (_name: string, fn: (span: unknown) => unknown) => fn({}),
    );
    propagateAttributes.mockReset();
    propagateAttributes.mockImplementation((_attrs: unknown, fn: () => unknown) => fn());
    setActiveTraceIO.mockReset();
    delete process.env.LANGFUSE_TRACING;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_TIMEOUT;
  });

  it("emits root asType event without parent (webhook-style)", async () => {
    enableLangfuseEnv();
    const { emitLangfuseEvent, setLangfuseEnabledForTests } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    emitLangfuseEvent("reminder_sent", {
      outcome: "success",
      telegram_user_id: "42",
      meeting_count: 1,
      hitl: true,
      meeting_ids: ["m-1"],
      firstName: "Ada",
    });
    expect(startObservation).toHaveBeenCalledWith(
      "reminder_sent",
      expect.objectContaining({
        input: expect.objectContaining({
          outcome: "success",
          telegram_user_id: "42",
          meeting_count: 1,
          firstName: "Ada",
        }),
      }),
      { asType: "event" },
    );
  });

  it("never throws when startObservation fails", async () => {
    enableLangfuseEnv();
    startObservation.mockImplementation(() => {
      throw new Error("boom");
    });
    const { emitLangfuseEvent, setLangfuseEnabledForTests } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    expect(() => emitLangfuseEvent("tool_error", { tool: "x", error_message: "y" })).not.toThrow();
  });

  it("bounds flush when forceFlush hangs", async () => {
    enableLangfuseEnv();
    process.env.LANGFUSE_TIMEOUT = "0.05";
    forceFlush.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );
    const {
      startLangfuseTracing,
      flushLangfuseTracing,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    startLangfuseTracing();
    const started = Date.now();
    await flushLangfuseTracing();
    expect(Date.now() - started).toBeLessThan(5_000);
    await resetLangfuseTracingForTests();
  });

  it("clears the flush race timer after a successful forceFlush", async () => {
    enableLangfuseEnv();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const {
      startLangfuseTracing,
      flushLangfuseTracing,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    startLangfuseTracing();
    await flushLangfuseTracing();
    expect(forceFlush).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    await resetLangfuseTracingForTests();
  });

  it("propagates fn errors without re-invoking fn", async () => {
    enableLangfuseEnv();
    const { withClinicTurn, setLangfuseEnabledForTests } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    const fn = vi.fn(async () => {
      throw new Error("crm write failed after mutation");
    });
    await expect(
      withClinicTurn(
        { userId: "u1", sessionId: "s1", input: "hi" },
        fn,
      ),
    ).rejects.toThrow("crm write failed after mutation");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("falls back to fn(undefined) only when tracing setup fails before fn starts", async () => {
    enableLangfuseEnv();
    startActiveObservation.mockImplementation(() => {
      throw new Error("otel span start failed");
    });
    const { withClinicTurn, setLangfuseEnabledForTests } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    const fn = vi.fn(async (callbacks: unknown) => {
      expect(callbacks).toBeUndefined();
      return { result: "ok", output: "done" };
    });
    await expect(
      withClinicTurn({ userId: "u1", sessionId: "s1", input: "hi" }, fn),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(undefined);
  });

  it("reuses the same CallbackHandler for the same sessionId across turns", async () => {
    enableLangfuseEnv();
    const {
      withClinicTurn,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);

    const seen: unknown[] = [];
    const capture = async (callbacks: unknown) => {
      seen.push(callbacks);
      return { result: "ok", output: "done" };
    };

    await withClinicTurn({ userId: "u1", sessionId: "thread-a", input: "one" }, capture);
    await withClinicTurn({ userId: "u1", sessionId: "thread-a", input: "two" }, capture);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);

    await withClinicTurn({ userId: "u2", sessionId: "thread-b", input: "other" }, capture);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toBeDefined();
    expect(seen[2]).not.toBe(seen[0]);

    await resetLangfuseTracingForTests();
    await withClinicTurn({ userId: "u1", sessionId: "thread-a", input: "again" }, capture);
    expect(seen).toHaveLength(4);
    expect(seen[3]).toBeDefined();
    expect(seen[3]).not.toBe(seen[0]);
  });

  it("createClinicTurnCallbackHandler shares the session cache with withClinicTurn", async () => {
    enableLangfuseEnv();
    const {
      withClinicTurn,
      createClinicTurnCallbackHandler,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);

    let fromTurn: unknown;
    await withClinicTurn(
      { userId: "u1", sessionId: "shared", input: "hi" },
      async (callbacks) => {
        fromTurn = callbacks;
        return { result: "ok", output: "done" };
      },
    );
    const fromCreate = createClinicTurnCallbackHandler({
      userId: "u1",
      sessionId: "shared",
    });
    expect(fromCreate).toBe(fromTurn);
    await resetLangfuseTracingForTests();
  });

  it("releaseClinicTurnCallbackHandler drops a session so the next turn gets a new handler", async () => {
    enableLangfuseEnv();
    const {
      withClinicTurn,
      releaseClinicTurnCallbackHandler,
      clinicTurnCallbackHandlerCacheSizeForTests,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);

    const seen: unknown[] = [];
    const capture = async (callbacks: unknown) => {
      seen.push(callbacks);
      return { result: "ok", output: "done" };
    };
    await withClinicTurn({ userId: "u1", sessionId: "drop-me", input: "a" }, capture);
    expect(clinicTurnCallbackHandlerCacheSizeForTests()).toBe(1);
    releaseClinicTurnCallbackHandler("drop-me");
    expect(clinicTurnCallbackHandlerCacheSizeForTests()).toBe(0);
    await withClinicTurn({ userId: "u1", sessionId: "drop-me", input: "b" }, capture);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeDefined();
    expect(seen[1]).not.toBe(seen[0]);
    await resetLangfuseTracingForTests();
  });

  it("evicts the least-recently-used handler when the session cap is hit", async () => {
    enableLangfuseEnv();
    const {
      withClinicTurn,
      clinicTurnCallbackHandlerCacheSizeForTests,
      setClinicTurnCallbackHandlerCacheLimitsForTests,
      setLangfuseEnabledForTests,
      resetLangfuseTracingForTests,
    } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    setClinicTurnCallbackHandlerCacheLimitsForTests({ maxSessions: 2 });

    const noop = async () => ({ result: "ok", output: "done" });
    await withClinicTurn({ userId: "u1", sessionId: "a", input: "1" }, noop);
    await withClinicTurn({ userId: "u1", sessionId: "b", input: "2" }, noop);
    expect(clinicTurnCallbackHandlerCacheSizeForTests()).toBe(2);
    await withClinicTurn({ userId: "u1", sessionId: "c", input: "3" }, noop);
    expect(clinicTurnCallbackHandlerCacheSizeForTests()).toBe(2);

    const seen: unknown[] = [];
    await withClinicTurn(
      { userId: "u1", sessionId: "a", input: "again" },
      async (callbacks) => {
        seen.push(callbacks);
        return { result: "ok", output: "done" };
      },
    );
    // "a" was evicted; a fresh handler is created.
    expect(seen[0]).toBeDefined();
    expect(clinicTurnCallbackHandlerCacheSizeForTests()).toBe(2);
    await resetLangfuseTracingForTests();
  });
});

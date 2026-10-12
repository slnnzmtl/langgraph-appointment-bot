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
        }),
      }),
      { asType: "event" },
    );
    const input = startObservation.mock.calls[0]?.[1]?.input as Record<string, unknown>;
    expect(input).not.toHaveProperty("firstName");
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
});

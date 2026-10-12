import { afterEach, describe, expect, it, vi } from "vitest";

const startObservation = vi.fn();
const forceFlush = vi.fn(async () => undefined);

vi.mock("@langfuse/tracing", () => ({
  propagateAttributes: (_attrs: unknown, fn: () => unknown) => fn(),
  startActiveObservation: (_name: string, fn: (span: unknown) => unknown) => fn({}),
  setActiveTraceIO: vi.fn(),
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

describe("emitLangfuseEvent / flushLangfuseTracing", () => {
  afterEach(async () => {
    vi.resetModules();
    startObservation.mockReset();
    forceFlush.mockReset();
    forceFlush.mockImplementation(async () => undefined);
    delete process.env.LANGFUSE_TRACING;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
    delete process.env.LANGFUSE_TIMEOUT;
  });

  it("emits root asType event without parent (webhook-style)", async () => {
    process.env.LANGFUSE_TRACING = "true";
    process.env.LANGFUSE_PUBLIC_KEY = "pk";
    process.env.LANGFUSE_SECRET_KEY = "sk";
    process.env.LANGFUSE_BASE_URL = "http://langfuse-web:3000";
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
    process.env.LANGFUSE_TRACING = "true";
    process.env.LANGFUSE_PUBLIC_KEY = "pk";
    process.env.LANGFUSE_SECRET_KEY = "sk";
    process.env.LANGFUSE_BASE_URL = "http://langfuse-web:3000";
    startObservation.mockImplementation(() => {
      throw new Error("boom");
    });
    const { emitLangfuseEvent, setLangfuseEnabledForTests } = await import("../langfuse.js");
    setLangfuseEnabledForTests(true);
    expect(() => emitLangfuseEvent("tool_error", { tool: "x", error_message: "y" })).not.toThrow();
  });

  it("bounds flush when forceFlush hangs", async () => {
    process.env.LANGFUSE_TRACING = "true";
    process.env.LANGFUSE_PUBLIC_KEY = "pk";
    process.env.LANGFUSE_SECRET_KEY = "sk";
    process.env.LANGFUSE_BASE_URL = "http://langfuse-web:3000";
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
});

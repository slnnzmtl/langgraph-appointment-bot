import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tool } from "@langchain/core/tools";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
} from "@langfuse/tracing";
import { z } from "zod";

const USER_TEXT = '{"symptom":"rash"}';
const ASSISTANT_TEXT = "Підтвердіть, будь ласка: консультація завтра о 10:00.";

describe("langfuse export without mask", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider | undefined;
  let processor: LangfuseSpanProcessor | undefined;

  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:9";
    exporter.reset();
    // No mask — export payloads as-is for debugging.
    processor = new LangfuseSpanProcessor({
      exporter,
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "http://127.0.0.1:9",
      exportMode: "immediate",
      timeout: 1,
      shouldExportSpan: () => true,
    });
    provider = new NodeTracerProvider({
      spanProcessors: [processor],
    });
    provider.register();
  });

  afterEach(async () => {
    await processor?.forceFlush().catch(() => undefined);
    await processor?.shutdown().catch(() => undefined);
    await provider?.shutdown().catch(() => undefined);
    exporter.reset();
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_BASE_URL;
  });

  it("exports setActiveTraceIO conversation text without masking", async () => {
    const echoTool = tool(
      async () => JSON.stringify({ ok: true, firstName: "Ada" }),
      {
        name: "echo_ok",
        description: "Minimal tool for CallbackHandler path",
        schema: z.object({ note: z.string() }),
      },
    );

    await propagateAttributes(
      {
        traceName: "clinic-turn",
        userId: "1363967211",
        sessionId: "1363967211",
        tags: ["telegram"],
        metadata: { source: "telegram" },
      },
      () =>
        startActiveObservation("adapter", async () => {
          const handler = new CallbackHandler({
            userId: "1363967211",
            sessionId: "1363967211",
            tags: ["telegram"],
            traceMetadata: { source: "telegram" },
          });
          await echoTool.invoke({ note: "hi" }, { callbacks: [handler] });
          setActiveTraceIO({
            input: USER_TEXT,
            output: ASSISTANT_TEXT,
          });
        }),
    );

    await processor!.forceFlush();

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThan(0);

    const traceInputs = finished.map((s) => s.attributes["langfuse.trace.input"]);
    const traceOutputs = finished.map((s) => s.attributes["langfuse.trace.output"]);

    expect(traceInputs).toContain(USER_TEXT);
    expect(traceOutputs).toContain(ASSISTANT_TEXT);
  });
});

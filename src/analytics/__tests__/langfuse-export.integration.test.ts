import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";

import { maskLangfusePayload } from "../privacy.js";

const USER_TEXT = "Хочу записатись завтра о 10:00";
const ASSISTANT_TEXT = "Підтвердіть, будь ласка: консультація завтра о 10:00.";

const spanPayloadBlob = (span: {
  attributes: Record<string, unknown>;
}): string => JSON.stringify(span.attributes);

describe("langfuse export privacy integration", () => {
  const exporter = new InMemorySpanExporter();
  let provider: NodeTracerProvider | undefined;
  let processor: LangfuseSpanProcessor | undefined;

  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:9";
    exporter.reset();
    // Custom exporter receives spans after LangfuseSpanProcessor.mask — no live HTTP.
    processor = new LangfuseSpanProcessor({
      exporter,
      mask: maskLangfusePayload,
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

  it("exports conversation text and strips secrets, CRM dumps, checkpoint, headers", async () => {
    await propagateAttributes(
      {
        traceName: "clinic-turn",
        userId: "1363967211",
        sessionId: "1363967211",
        tags: ["telegram"],
        metadata: { source: "telegram" },
      },
      () =>
        // Wrapper is "adapter"; traceName stays "clinic-turn" (matches production withClinicTurn).
        startActiveObservation("adapter", async () => {
          startObservation(
            "tool",
            {
              input: {
                GOOGLE_API_KEY: "AIzaSyIntegrationSecret",
                ESPOCRM_API_KEY: "espocrm-secret-key",
                Authorization: "Bearer sk-live-token",
                bookingDraft: { note: "patient free text note", serviceId: "svc-1" },
                pendingInteraction: { kind: "mutation_confirm" },
                contactContext: {
                  firstName: "Ada",
                  phoneNumber: "+380501112233",
                  email: "ada@example.com",
                },
                contacts: [{ id: "c-1", firstName: "Ada", phoneNumber: "+380501112233" }],
                messages: [{ role: "human", content: "checkpoint messages" }],
                tool_dump: {
                  raw_mcp: { success: true, contacts: [{ id: "c-1" }] },
                },
                meeting_id: "meet-1",
              },
              output: { error: "ok", contact_id: "c-1" },
            },
            { asType: "tool" },
          ).end();

          setActiveTraceIO({
            input: USER_TEXT,
            output: ASSISTANT_TEXT,
          });
        }),
    );

    await processor!.forceFlush();

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThan(0);

    const all = finished.map(spanPayloadBlob).join("\n");

    expect(all).toContain(USER_TEXT);
    expect(all).toContain(ASSISTANT_TEXT);

    expect(all).not.toContain("AIzaSyIntegrationSecret");
    expect(all).not.toContain("espocrm-secret-key");
    expect(all).not.toContain("sk-live-token");
    expect(all).not.toContain("+380501112233");
    expect(all).not.toContain("ada@example.com");
    expect(all).not.toContain("patient free text note");
    expect(all).not.toContain("checkpoint messages");

    // Omitted object markers or absence of nested CRM dumps
    const hasRawContactsArray = /"contacts"\s*:\s*\[/.test(all);
    expect(hasRawContactsArray).toBe(false);
  });
});

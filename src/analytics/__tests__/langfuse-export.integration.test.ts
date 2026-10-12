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

import { asClinicTurnConversation, maskLangfusePayload } from "../privacy.js";

const USER_TEXT = '{"symptom":"rash"}';
const ASSISTANT_TEXT = "Підтвердіть, будь ласка: консультація завтра о 10:00.";

const LEAK_FIRST = "Ada";
const LEAK_LAST = "Lovelace";
const LEAK_STREET = "42 Baker Street PII";
const LEAK_NOTE = "hypertension medical note dump";
const LEAK_RAW = "raw_mcp_contacts_blob_unique";
const LEAK_ARRAY_NAME = "Ada Lovelace";
const LEAK_ARRAY_NOTE = "hypertension medical note";

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

  it("CallbackHandler path masks PII dumps/arrays and keeps JSON conversation text", async () => {
    const leakyTool = tool(
      async () =>
        JSON.stringify({
          firstName: LEAK_FIRST,
          lastName: LEAK_LAST,
          addressStreet: LEAK_STREET,
          medicalNote: LEAK_NOTE,
          raw_mcp: { marker: LEAK_RAW, contacts: [{ id: "c-1" }] },
          contact_id: "c-1",
          outcome: "success",
        }),
      {
        name: "update_contact_leaky",
        description: "Integration fixture that returns CRM-shaped PII",
        schema: z.object({
          firstName: z.string(),
          lastName: z.string(),
          addressStreet: z.string(),
          medicalNote: z.string(),
        }),
      },
    );

    const arrayTool = tool(
      async () => JSON.stringify([LEAK_ARRAY_NAME, LEAK_ARRAY_NOTE]),
      {
        name: "list_notes_leaky",
        description: "Returns a bare JSON array of CRM strings",
        schema: z.object({}),
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
          await leakyTool.invoke(
            {
              firstName: LEAK_FIRST,
              lastName: LEAK_LAST,
              addressStreet: LEAK_STREET,
              medicalNote: LEAK_NOTE,
            },
            { callbacks: [handler] },
          );
          await arrayTool.invoke({}, { callbacks: [handler] });
          setActiveTraceIO({
            input: asClinicTurnConversation(USER_TEXT),
            output: asClinicTurnConversation(ASSISTANT_TEXT),
          });
        }),
    );

    await processor!.forceFlush();

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBeGreaterThan(0);

    const all = finished.map(spanPayloadBlob).join("\n");
    const traceInputs = finished.map((s) => s.attributes["langfuse.trace.input"]);
    const traceOutputs = finished.map((s) => s.attributes["langfuse.trace.output"]);

    expect(traceInputs).toContain(USER_TEXT);
    expect(traceOutputs).toContain(ASSISTANT_TEXT);
    expect(all).not.toContain("clinic-turn-io");

    expect(all).not.toContain(LEAK_FIRST);
    expect(all).not.toContain(LEAK_LAST);
    expect(all).not.toContain(LEAK_STREET);
    expect(all).not.toContain(LEAK_NOTE);
    expect(all).not.toContain(LEAK_RAW);
    expect(all).not.toContain("raw_mcp");
    expect(all).not.toContain(LEAK_ARRAY_NAME);
    expect(all).not.toContain(LEAK_ARRAY_NOTE);

    const toolOutputs = finished
      .filter((s) => s.attributes["langfuse.observation.type"] === "tool")
      .map((s) => String(s.attributes["langfuse.observation.output"] ?? ""));
    expect(toolOutputs.some((o) => o === "[]")).toBe(true);
  });
});

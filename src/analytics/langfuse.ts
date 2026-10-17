/**
 * Langfuse / OpenTelemetry sink. Sole importer of @langfuse/* and @opentelemetry/*
 * besides process boot (via track.ts re-exports). Business code must not import this
 * module's SDK packages directly — use track.ts / withClinicTurn.
 */
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import { errorMessage } from "../shared/json-record.js";
import { toPropagateMetadata } from "./privacy.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SECONDS = 5;
const FLUSH_SLACK_MS = 1_000;

let tracerProvider: NodeTracerProvider | undefined;
let spanProcessor: LangfuseSpanProcessor | undefined;
let started = false;
/** Test-only override for enablement without env. */
let enabledForTests: boolean | null = null;

/**
 * One CallbackHandler per chat thread so HITL resume `*End` callbacks still
 * find the interrupted spans in runMap (new handler per invoke caused WARNs).
 */
const handlersBySessionId = new Map<string, CallbackHandler>();

const readTimeoutSeconds = (): number => {
  const raw = process.env.LANGFUSE_TIMEOUT;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_SECONDS;
};

const resolveRelease = (): string | undefined => {
  if (process.env.LANGFUSE_RELEASE?.trim()) {
    return process.env.LANGFUSE_RELEASE.trim();
  }
  if (process.env.GIT_SHA?.trim()) {
    return process.env.GIT_SHA.trim();
  }
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
};

export const isLangfuseTracingEnabled = (): boolean => {
  if (enabledForTests !== null) {
    return enabledForTests;
  }
  if (process.env.LANGFUSE_TRACING !== "true") {
    return false;
  }
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();
  if (!publicKey || !secretKey || !baseUrl) {
    console.warn(
      "LANGFUSE_TRACING=true but LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL incomplete — Langfuse tracing off",
    );
    return false;
  }
  return true;
};

/** Test helpers — do not use in production code. */
export const setLangfuseEnabledForTests = (value: boolean | null): void => {
  enabledForTests = value;
};

export const getLangfuseSpanProcessorForTests = (): LangfuseSpanProcessor | undefined =>
  spanProcessor;

export type StartLangfuseTracingOptions = {
  /** Inject InMemorySpanExporter (or similar) for integration tests — no HTTP. */
  exporter?: SpanExporter;
};

/**
 * Idempotent OTel + LangfuseSpanProcessor boot. Never throws.
 */
export const startLangfuseTracing = (options?: StartLangfuseTracingOptions): void => {
  if (started) {
    return;
  }
  if (!isLangfuseTracingEnabled() && !options?.exporter) {
    return;
  }
  try {
    const timeout = readTimeoutSeconds();
    const environment =
      process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim()
      || (process.env.NODE_ENV === "production" ? "production" : "development");
    const release = resolveRelease();
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
    const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
    const baseUrl = process.env.LANGFUSE_BASE_URL?.trim();
    spanProcessor = new LangfuseSpanProcessor({
      ...(options?.exporter ? { exporter: options.exporter } : {}),
      timeout,
      environment,
      ...(release ? { release } : {}),
      ...(publicKey ? { publicKey } : {}),
      ...(secretKey ? { secretKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    tracerProvider = new NodeTracerProvider({
      spanProcessors: [spanProcessor],
    });
    tracerProvider.register();
    started = true;
  } catch (error: unknown) {
    console.warn(`Langfuse tracing boot failed: ${errorMessage(error)}`);
    spanProcessor = undefined;
    tracerProvider = undefined;
    started = false;
  }
};

/** Public callback type for adapter invoke configs (re-exported via track.ts). */
export type ClinicTurnCallbacks = CallbackHandler;

export type WithClinicTurnOptions = {
  userId: string;
  sessionId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** User message text for trace input. */
  input: string;
};

const handlerForSession = (options: {
  userId: string;
  sessionId: string;
  tags: string[];
  metadata: Record<string, unknown>;
}): CallbackHandler | undefined => {
  const cached = handlersBySessionId.get(options.sessionId);
  if (cached != null) {
    return cached;
  }
  try {
    const handler = new CallbackHandler({
      userId: options.userId,
      sessionId: options.sessionId,
      tags: options.tags,
      traceMetadata: options.metadata,
    });
    handlersBySessionId.set(options.sessionId, handler);
    return handler;
  } catch (error: unknown) {
    console.warn(`CallbackHandler create failed: ${errorMessage(error)}`);
    return undefined;
  }
};

/**
 * One Langfuse clinic-turn: propagateAttributes wraps startActiveObservation;
 * setActiveTraceIO sets conversation I/O at trace level after the turn.
 * Wrapper observation is named "adapter" (not "clinic-turn") so LangGraph's
 * runName "clinic-turn" is the sole observation with that name under the trace.
 * When Langfuse is off, runs `fn` with undefined callbacks (passthrough).
 * Application errors from `fn` always propagate — never re-invoke `fn` after it starts.
 */
export const withClinicTurn = async <T>(
  options: WithClinicTurnOptions,
  fn: (callbacks: ClinicTurnCallbacks | undefined) => Promise<{ result: T; output: string }>,
): Promise<T> => {
  if (!isLangfuseTracingEnabled()) {
    const { result } = await fn(undefined);
    return result;
  }

  const tags = options.tags ?? ["telegram"];
  const metadata = toPropagateMetadata({
    source: "telegram",
    telegram_user_id: options.userId,
    chat_id: options.sessionId,
    ...options.metadata,
  });

  const handler = handlerForSession({
    userId: options.userId,
    sessionId: options.sessionId,
    tags,
    metadata,
  });

  let fnStarted = false;
  try {
    return await propagateAttributes(
      {
        traceName: "clinic-turn",
        userId: options.userId.slice(0, 200),
        sessionId: options.sessionId.slice(0, 200),
        tags,
        metadata,
      },
      () =>
        startActiveObservation("adapter", async () => {
          fnStarted = true;
          const { result, output } = await fn(handler);
          try {
            setActiveTraceIO({
              input: options.input,
              output,
            });
          } catch (error: unknown) {
            console.warn(`setActiveTraceIO failed: ${errorMessage(error)}`);
          }
          return result;
        }),
    );
  } catch (error: unknown) {
    if (fnStarted) {
      throw error;
    }
    console.warn(`withClinicTurn Langfuse wrap failed: ${errorMessage(error)}`);
    const { result } = await fn(undefined);
    return result;
  }
};

/** Create a CallbackHandler for direct graph.invoke paths (e.g. smoke identity). */
export const createClinicTurnCallbackHandler = (options: {
  userId: string;
  sessionId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): CallbackHandler | undefined => {
  if (!isLangfuseTracingEnabled()) {
    return undefined;
  }
  const tags = options.tags ?? ["telegram"];
  return handlerForSession({
    userId: options.userId,
    sessionId: options.sessionId,
    tags,
    metadata: toPropagateMetadata({
      telegram_user_id: options.userId,
      chat_id: options.sessionId,
      ...options.metadata,
    }),
  });
};

/**
 * Tier 1 event observation. Fire-and-forget; never throws.
 * Nests under the active adapter observation; without a parent becomes a root (webhook).
 */
export const emitLangfuseEvent = (
  name: string,
  props: Record<string, unknown>,
): void => {
  if (!isLangfuseTracingEnabled()) {
    return;
  }
  try {
    // Event observations auto-end; asType: "event"
    startObservation(
      name,
      {
        input: props,
        metadata: toPropagateMetadata(props),
      },
      { asType: "event" },
    );
  } catch (error: unknown) {
    console.warn(`emitLangfuseEvent failed (${name}): ${errorMessage(error)}`);
  }
};

/**
 * Bounded forceFlush + optional provider shutdown. Never hangs past timeout+slack.
 * Clears the race timer on success so smoke/CLI exit is not delayed.
 */
export const flushLangfuseTracing = async (): Promise<void> => {
  if (!spanProcessor) {
    return;
  }
  const timeoutMs = readTimeoutSeconds() * 1_000 + FLUSH_SLACK_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      spanProcessor.forceFlush(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Langfuse forceFlush timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error: unknown) {
    console.warn(`Langfuse flush failed: ${errorMessage(error)}`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/** Reset module state after integration tests. */
export const resetLangfuseTracingForTests = async (): Promise<void> => {
  try {
    if (spanProcessor) {
      await spanProcessor.shutdown().catch(() => undefined);
    }
    if (tracerProvider) {
      await tracerProvider.shutdown().catch(() => undefined);
    }
  } finally {
    spanProcessor = undefined;
    tracerProvider = undefined;
    started = false;
    enabledForTests = null;
    handlersBySessionId.clear();
  }
};

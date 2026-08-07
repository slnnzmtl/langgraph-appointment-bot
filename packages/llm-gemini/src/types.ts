import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";

export type RoutingChain<TRoute> = {
  invoke(input: unknown, config?: RunnableConfig): Promise<TRoute>;
};

export type BindRoutingToolsOptions = {
  /** When set, structured routing runs against this model (e.g. a Gemini cached-content client). */
  model?: BaseChatModel;
};

export interface ILLMConnector {
  getModel(): BaseChatModel;
  bindRoutingTools<TRoute extends Record<string, unknown>>(
    schema: z.ZodType<TRoute>,
    options?: BindRoutingToolsOptions,
  ): RoutingChain<TRoute>;
}

export type ContextCacheSpec = {
  modelName: string;
  staticSystemInstruction: string;
  tools: StructuredToolInterface[];
  displayName: string;
  ttlSeconds?: number;
};

export type ContextCacheHandle = {
  cacheName: string;
  /** Gemini model resource name, e.g. models/gemini-2.5-flash (required by useCachedContent). */
  model: string;
};

export type ContextCacheManager = {
  getOrCreate(spec: ContextCacheSpec): Promise<ContextCacheHandle | null>;
  /** Drop a cached handle so the next getOrCreate recreates it (e.g. after Gemini TTL 403). */
  invalidate(cacheName: string): void;
};

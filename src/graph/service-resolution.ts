import { z } from "zod";

import type { McpCallTool } from "../shared/mcp.js";
import { asJsonRecord } from "../shared/json-record.js";
import type { BookingService } from "./booking-draft.js";
import type {
  ResolveServiceChange,
  ServiceResolutionResult,
} from "./booking-note-orchestrator.js";
import type { ResolveServiceEffect } from "./pending-interaction.js";
import type { ILLMConnector } from "./types.js";

export type ServiceCatalogRow = {
  id: string;
  name: string;
  duration?: number;
  description?: string;
};

export type CatalogFetchResult =
  | { ok: true; rows: ServiceCatalogRow[] }
  | { ok: false; reason: "incomplete" | "error" };

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 50;

const parseServicePage = (
  raw: unknown,
): { list: ServiceCatalogRow[]; total?: number } | null => {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const record = asJsonRecord(text);
  if (!record || typeof record.error === "string" || !Array.isArray(record.list)) {
    return null;
  }
  const list: ServiceCatalogRow[] = [];
  for (const entry of record.list) {
    const row = asJsonRecord(entry);
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
      continue;
    }
    const id = row.id.trim();
    const name = row.name.trim();
    if (id.length === 0 || name.length === 0) {
      continue;
    }
    list.push({
      id,
      name,
      ...(row.duration !== undefined && row.duration !== null
        ? { duration: Number(row.duration) }
        : {}),
      ...(typeof row.description === "string" && row.description.trim().length > 0
        ? { description: row.description.trim() }
        : {}),
    });
  }
  return {
    list,
    ...(typeof record.total === "number" ? { total: record.total } : {}),
  };
};

/** Paginate cService until the read is complete. Never rank a partial catalog. */
export const fetchCompleteServiceCatalog = async (
  callTool: McpCallTool,
  options?: { pageSize?: number },
): Promise<CatalogFetchResult> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const collected: ServiceCatalogRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total: number | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let raw: unknown;
    try {
      raw = await callTool("search_entity", {
        entityType: "cService",
        select: ["id", "name", "duration", "description"],
        limit: pageSize,
        offset,
      });
    } catch {
      return { ok: false, reason: "error" };
    }
    const parsed = parseServicePage(raw);
    if (parsed == null) {
      return { ok: false, reason: "error" };
    }
    if (parsed.total != null) {
      total = parsed.total;
    }
    for (const row of parsed.list) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        collected.push(row);
      }
    }
    if (parsed.list.length < pageSize) {
      if (total != null && collected.length < total) {
        return { ok: false, reason: "incomplete" };
      }
      return { ok: true, rows: collected };
    }
    if (total == null) {
      return { ok: false, reason: "incomplete" };
    }
    if (collected.length >= total) {
      return { ok: true, rows: collected };
    }
    offset += pageSize;
  }
  return { ok: false, reason: "incomplete" };
};

const casefold = (value: string): string =>
  value.trim().toLocaleLowerCase().replace(/\s+/g, " ");

const exactNameMatches = (
  rows: ServiceCatalogRow[],
  query: string,
): ServiceCatalogRow[] => {
  const needle = casefold(query);
  return rows.filter((row) => casefold(row.name) === needle);
};

const toBookingService = (row: ServiceCatalogRow): BookingService => ({
  id: row.id,
  name: row.name,
  source: "catalog",
  ...(row.duration != null && Number.isFinite(row.duration)
    ? { durationMinutes: row.duration }
    : {}),
});

const selectionSchema = z.object({
  serviceIds: z.array(z.string()).default([]),
});

export type SelectServiceCandidates = (input: {
  utterance: string;
  query?: string;
  candidates: Array<{ id: string; name: string; description?: string }>;
}) => Promise<string[]>;

export const createServiceCandidateSelector = (
  llm: ILLMConnector,
): SelectServiceCandidates => {
  const chain = llm.bindRoutingTools(selectionSchema, {
    name: "select_service_candidates",
  });
  return async ({ utterance, query, candidates }) => {
    const result = await chain.invoke([
      {
        role: "system",
        content:
          "Select zero or more clinic service ids from the candidate list that match the patient request. "
          + "Return only ids from the list. Prefer fewer ids when confident. Return an empty list when none fit.",
      },
      {
        role: "user",
        content: JSON.stringify({
          utterance,
          ...(query != null ? { query } : {}),
          candidates,
        }),
      },
    ]);
    const parsed = selectionSchema.safeParse(result);
    return parsed.success ? parsed.data.serviceIds : [];
  };
};

export type ResolveServiceChangeDeps = {
  fetchCatalog: () => Promise<CatalogFetchResult>;
  selectCandidates: SelectServiceCandidates;
};

export const resolveServiceChange = async (
  effect: ResolveServiceEffect,
  deps: ResolveServiceChangeDeps,
): Promise<ServiceResolutionResult> => {
  const catalog = await deps.fetchCatalog();
  if (!catalog.ok) {
    return { type: "service_unresolved" };
  }
  const allowlist = new Map(catalog.rows.map((row) => [row.id, row]));
  const probe = effect.query ?? effect.utterance;
  let selectedIds: string[];
  if (allowlist.has(probe)) {
    selectedIds = [probe];
  } else {
    const exact = exactNameMatches(catalog.rows, probe);
    if (exact.length === 1) {
      selectedIds = [exact[0]!.id];
    } else {
      const rawIds = await deps.selectCandidates({
        utterance: effect.utterance,
        ...(effect.query != null ? { query: effect.query } : {}),
        candidates: catalog.rows.map((row) => ({
          id: row.id,
          name: row.name,
          ...(row.description != null ? { description: row.description } : {}),
        })),
      });
      selectedIds = [...new Set(rawIds.filter((id) => allowlist.has(id)))];
      if (rawIds.some((id) => !allowlist.has(id)) && selectedIds.length === 0) {
        return { type: "service_unresolved" };
      }
    }
  }

  if (selectedIds.length === 0) {
    return { type: "service_unresolved" };
  }
  if (selectedIds.length === 1) {
    const row = allowlist.get(selectedIds[0]!)!;
    return {
      type: "service_changed",
      service: toBookingService(row),
      accepted: true,
      ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
    };
  }
  return {
    type: "service_candidates_opened",
    utterance: effect.utterance,
    ...(effect.query != null ? { query: effect.query } : {}),
    ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
    choices: selectedIds.map((id) => {
      const row = allowlist.get(id)!;
      return { id: row.id, label: row.name };
    }),
  };
};

export const createResolveServiceChange = (
  callTool: McpCallTool,
  llm: ILLMConnector,
): ResolveServiceChange => {
  const selectCandidates = createServiceCandidateSelector(llm);
  return async (effect) =>
    resolveServiceChange(effect, {
      fetchCatalog: () => fetchCompleteServiceCatalog(callTool),
      selectCandidates,
    });
};

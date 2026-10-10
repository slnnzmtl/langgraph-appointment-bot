import { z } from "zod";

import { trackToolError } from "../analytics/track.js";
import { SERVICE_CANDIDATE_OTHER_LABEL_UK } from "../shared/clinic-constants.js";
import type { McpCallTool } from "../shared/mcp.js";
import { asJsonRecord } from "../shared/json-record.js";
import type { BookingService } from "./booking-draft.js";
import type {
  ResolveServiceChange,
  ServiceResolutionResult,
} from "./booking-note-orchestrator.js";
import type { InteractionChoice, ResolveServiceEffect } from "./booking-session.js";
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

const selectionGroupSchema = z.object({
  label: z.string().min(1),
  serviceIds: z.array(z.string()).min(1),
});

const selectionSchema = z.object({
  serviceIds: z.array(z.string()).default([]),
  groups: z.array(selectionGroupSchema).optional(),
});

const partitionSchema = z.object({
  groups: z.array(selectionGroupSchema).default([]),
});

export type ServiceCandidateSelection = {
  serviceIds: string[];
  groups?: Array<{ label: string; serviceIds: string[] }>;
};

export type SelectServiceCandidates = (input: {
  utterance: string;
  query?: string;
  candidates: Array<{ id: string; name: string; description?: string }>;
}) => Promise<ServiceCandidateSelection>;

/** Partition already-selected ids into one catalog level (no re-filtering). */
export type PartitionServiceCandidates = (input: {
  utterance: string;
  query?: string;
  candidates: Array<{ id: string; name: string; description?: string }>;
}) => Promise<Array<{ label: string; serviceIds: string[] }>>;

type PartitionInput = Parameters<PartitionServiceCandidates>[0];
type PartitionGroups = Awaited<ReturnType<PartitionServiceCandidates>>;

/** Run partitionCandidates; on failure log and return undefined so callers fall back. */
const safePartition = async (
  partitionCandidates: PartitionServiceCandidates | undefined,
  input: PartitionInput,
): Promise<PartitionGroups | undefined> => {
  if (partitionCandidates == null) {
    return undefined;
  }
  try {
    return await partitionCandidates(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trackToolError("partition_service_candidates", message);
    return undefined;
  }
};

type SelectInput = Parameters<SelectServiceCandidates>[0];
type SelectResult = Awaited<ReturnType<SelectServiceCandidates>>;

/** Run selectCandidates; on failure log and return undefined so callers fall back. */
const safeSelect = async (
  selectCandidates: SelectServiceCandidates,
  input: SelectInput,
): Promise<SelectResult | undefined> => {
  try {
    return await selectCandidates(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trackToolError("select_service_candidates", message);
    return undefined;
  }
};

/** System instruction for filter + one-level groups. */
export const SERVICE_CANDIDATE_SELECTOR_INSTRUCTION =
  "Select zero or more clinic service ids from the candidate list that match the patient request. "
  + "Return only ids from the list. Prefer fewer ids when confident. Return an empty list when none fit. "
  + "When more than one id matches, also return groups for exactly one distinguishing catalog level "
  + "among those ids: short labels that partition the selected ids (skip a level that has only one option). "
  + "Every selected id must appear in exactly one group. "
  + "Never invent ids. Never use full brand+zone CRM titles as group labels before the last distinguishing level.";

/** System instruction for partitioning a fixed remaining id set (no catalog filter). */
export const SERVICE_CANDIDATE_PARTITION_INSTRUCTION =
  "Partition the given clinic service ids into groups for exactly one distinguishing catalog level. "
  + "Short labels that partition the ids (skip a level that has only one option). "
  + "Every id must appear in exactly one group. "
  + "Never invent ids. Never drop ids. Never use full brand+zone CRM titles as group labels "
  + "before the last distinguishing level.";

/** First FAQ browse level after «Обрати іншу процедуру»: напрями, not families. */
export const FAQ_ROOT_PARTITION_QUERY =
  "Group the full clinic catalog into a few service directions (напрями послуг). "
  + "Do not use procedure families, zones, brands, or full CRM titles at this level.";

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
        content: SERVICE_CANDIDATE_SELECTOR_INSTRUCTION,
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
    if (!parsed.success) {
      return { serviceIds: [] };
    }
    return {
      serviceIds: parsed.data.serviceIds,
      ...(parsed.data.groups != null ? { groups: parsed.data.groups } : {}),
    };
  };
};

export const createServiceCandidatePartitioner = (
  llm: ILLMConnector,
): PartitionServiceCandidates => {
  const chain = llm.bindRoutingTools(partitionSchema, {
    name: "partition_service_candidates",
  });
  return async ({ utterance, query, candidates }) => {
    const result = await chain.invoke([
      {
        role: "system",
        content: SERVICE_CANDIDATE_PARTITION_INSTRUCTION,
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
    const parsed = partitionSchema.safeParse(result);
    return parsed.success ? parsed.data.groups : [];
  };
};

export type ResolveServiceChangeDeps = {
  fetchCatalog: () => Promise<CatalogFetchResult>;
  selectCandidates: SelectServiceCandidates;
  partitionCandidates?: PartitionServiceCandidates;
};

const sanitizeGroups = (
  groups: Array<{ label: string; serviceIds: string[] }> | undefined,
  allowlist: Map<string, ServiceCatalogRow>,
  selectedIds: ReadonlySet<string>,
): Array<{ label: string; serviceIds: string[] }> => {
  if (groups == null || groups.length === 0) {
    return [];
  }
  const covered = new Set<string>();
  const sanitized: Array<{ label: string; serviceIds: string[] }> = [];
  for (const group of groups) {
    const label = group.label.trim();
    if (label.length === 0) {
      continue;
    }
    const ids = [...new Set(
      group.serviceIds.filter((id) => allowlist.has(id) && selectedIds.has(id) && !covered.has(id)),
    )];
    if (ids.length === 0) {
      continue;
    }
    for (const id of ids) {
      covered.add(id);
    }
    sanitized.push({ label, serviceIds: ids });
  }
  // No usable groups at all → caller falls back to per-id chips. Partial coverage
  // still opens the valid chips and parks leftover selected ids under a fallback.
  if (sanitized.length === 0) {
    return [];
  }
  const uncovered = [...selectedIds].filter((id) => !covered.has(id) && allowlist.has(id));
  if (uncovered.length > 0) {
    sanitized.push({
      label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
      serviceIds: uncovered,
    });
  }
  return sanitized;
};

/** True when picking any group leaves fewer CRM ids than the current set. */
const groupsStrictlyShrink = (
  selectedIds: ReadonlyArray<string>,
  groups: ReadonlyArray<{ serviceIds: string[] }>,
): boolean => {
  if (groups.length === 0 || selectedIds.length === 0) {
    return false;
  }
  const maxRemaining = Math.max(...groups.map((group) => group.serviceIds.length));
  return maxRemaining < selectedIds.length;
};

const choicesFromGroups = (
  groups: Array<{ label: string; serviceIds: string[] }>,
  allowlist: Map<string, ServiceCatalogRow>,
): InteractionChoice[] =>
  groups.map((group, index) => {
    const serviceIds = group.serviceIds;
    const id = serviceIds.length === 1 ? serviceIds[0]! : `g${index}`;
    // Singleton groups apply that CRM id immediately — show the real service name,
    // not an abstract partition label the patient never confirmed.
    const label = serviceIds.length === 1
      ? (allowlist.get(serviceIds[0]!)?.name ?? group.label)
      : group.label;
    return {
      id,
      label,
      serviceIds,
    };
  });

const perIdChoices = (
  selectedIds: string[],
  allowlist: Map<string, ServiceCatalogRow>,
): InteractionChoice[] =>
  selectedIds.flatMap((id) => {
    const row = allowlist.get(id);
    if (row == null) {
      return [];
    }
    return [{ id, label: row.name, serviceIds: [id] }];
  });

const candidatesOpened = (
  effect: ResolveServiceEffect,
  choices: InteractionChoice[],
): ServiceResolutionResult => ({
  type: "service_candidates_opened",
  utterance: effect.utterance,
  ...(effect.query != null ? { query: effect.query } : {}),
  ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
  choices,
});

/**
 * Partition a fixed CRM id set into one catalog level of InteractionChoice chips.
 * Returns [] when the partitioner is missing, empty, or does not shrink the set
 * (caller should use a deterministic CRM-name fallback).
 */
export const partitionRemainingServiceChoices = async (input: {
  rows: ServiceCatalogRow[];
  remainingIds?: readonly string[];
  utterance: string;
  query?: string;
  partitionCandidates?: PartitionServiceCandidates;
}): Promise<InteractionChoice[]> => {
  const { partitionCandidates, utterance } = input;
  if (partitionCandidates == null) {
    return [];
  }
  const allowlist = new Map(input.rows.map((row) => [row.id, row]));
  const selectedIds = [
    ...new Set(
      (input.remainingIds != null && input.remainingIds.length > 0
        ? input.remainingIds
        : input.rows.map((row) => row.id)
      ).filter((id) => allowlist.has(id)),
    ),
  ];
  if (selectedIds.length <= 1) {
    return [];
  }
  const remainingRows = selectedIds.map((id) => allowlist.get(id)!);
  const groups = await safePartition(partitionCandidates, {
    utterance,
    ...(input.query != null ? { query: input.query } : {}),
    candidates: toCandidateRows(remainingRows),
  });
  if (groups == null) {
    return [];
  }
  const sanitized = sanitizeGroups(groups, allowlist, new Set(selectedIds));
  if (!groupsStrictlyShrink(selectedIds, sanitized)) {
    return [];
  }
  return choicesFromGroups(sanitized, allowlist);
};

const changedFromRow = (
  row: ServiceCatalogRow,
  effect: ResolveServiceEffect,
): ServiceResolutionResult => ({
  type: "service_changed",
  service: toBookingService(row),
  accepted: true,
  ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
});

/**
 * Allowlisted ids → groups when they shrink the set → else one CRM-name chip per id.
 */
const resultFromSelectedIds = (
  effect: ResolveServiceEffect,
  allowlist: Map<string, ServiceCatalogRow>,
  selectedIds: string[],
  groups: Array<{ label: string; serviceIds: string[] }> | undefined,
): ServiceResolutionResult => {
  if (selectedIds.length === 0) {
    return { type: "service_unresolved" };
  }
  if (selectedIds.length === 1) {
    const row = allowlist.get(selectedIds[0]!);
    return row != null ? changedFromRow(row, effect) : { type: "service_unresolved" };
  }

  const sanitized = sanitizeGroups(groups, allowlist, new Set(selectedIds));
  if (groupsStrictlyShrink(selectedIds, sanitized)) {
    return candidatesOpened(effect, choicesFromGroups(sanitized, allowlist));
  }

  const leaf = perIdChoices(selectedIds, allowlist);
  if (leaf.length === 0) {
    return { type: "service_unresolved" };
  }
  if (leaf.length === 1) {
    const row = allowlist.get(leaf[0]!.id);
    return row != null ? changedFromRow(row, effect) : { type: "service_unresolved" };
  }
  return candidatesOpened(effect, leaf);
};

const toCandidateRows = (
  rows: ServiceCatalogRow[],
): Array<{ id: string; name: string; description?: string }> =>
  rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.description != null ? { description: row.description } : {}),
  }));

export const resolveServiceChange = async (
  effect: ResolveServiceEffect,
  deps: ResolveServiceChangeDeps,
): Promise<ServiceResolutionResult> => {
  const catalog = await deps.fetchCatalog();
  if (!catalog.ok) {
    return { type: "service_unresolved" };
  }
  const allowlist = new Map(catalog.rows.map((row) => [row.id, row]));

  if (effect.remainingIds != null) {
    const remainingIds = [...new Set(
      effect.remainingIds.filter((id) => allowlist.has(id)),
    )];
    if (remainingIds.length === 0) {
      return { type: "service_unresolved" };
    }
    if (remainingIds.length === 1) {
      return changedFromRow(allowlist.get(remainingIds[0]!)!, effect);
    }
    const remainingRows = remainingIds.map((id) => allowlist.get(id)!);
    const probe = effect.query ?? effect.utterance;
    const groups = await safePartition(deps.partitionCandidates, {
      utterance: probe,
      candidates: toCandidateRows(remainingRows),
    });
    return resultFromSelectedIds(effect, allowlist, remainingIds, groups);
  }

  const probe = effect.query ?? effect.utterance;
  let selectedIds: string[];
  let selectionGroups: ServiceCandidateSelection["groups"];
  if (allowlist.has(probe)) {
    selectedIds = [probe];
  } else {
    const exact = exactNameMatches(catalog.rows, probe);
    if (exact.length === 1) {
      selectedIds = [exact[0]!.id];
    } else {
      const selection = await safeSelect(deps.selectCandidates, {
        utterance: probe,
        candidates: toCandidateRows(catalog.rows),
      });
      if (selection == null) {
        return { type: "service_unresolved" };
      }
      selectedIds = [...new Set(selection.serviceIds.filter((id) => allowlist.has(id)))];
      selectionGroups = selection.groups;
      if (selection.serviceIds.some((id) => !allowlist.has(id)) && selectedIds.length === 0) {
        return { type: "service_unresolved" };
      }
    }
  }

  return resultFromSelectedIds(effect, allowlist, selectedIds, selectionGroups);
};

export const createResolveServiceChange = (
  callTool: McpCallTool,
  llm: ILLMConnector,
): ResolveServiceChange => {
  const selectCandidates = createServiceCandidateSelector(llm);
  const partitionCandidates = createServiceCandidatePartitioner(llm);
  return async (effect) =>
    resolveServiceChange(effect, {
      fetchCatalog: () => fetchCompleteServiceCatalog(callTool),
      selectCandidates,
      partitionCandidates,
    });
};

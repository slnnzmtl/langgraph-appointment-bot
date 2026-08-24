import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import type { McpCallTool } from "../shared/mcp.js";
import { asJsonRecord } from "../shared/json-record.js";
import { CONTEXT_TAGS } from "../shared/clinic-constants.js";
import { toToolResult } from "./tool-result.js";

const USD_UAH_URL =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";

export type ReadToolsOptions = {
  callTool: McpCallTool;
  assignedUserId: string;
};

export type GetWorkingTimeArgs = {
  calendarId?: string;
  userId?: string;
  teamId?: string;
  name?: string;
  limit?: number;
  offset?: number;
};

/** Max rows kept in checkpointed / prompt `<list_services>` context. */
export const SERVICES_CONTEXT_MAX_ROWS = 60;
/** Max description chars kept per service in context. */
export const SERVICES_CONTEXT_DESC_MAX = 160;

export type ServicesContext = {
  list: Array<{
    id: string;
    name: string;
    duration?: number;
    description?: string;
  }>;
  total?: number;
  truncated?: boolean;
};

const truncateServiceDescription = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= SERVICES_CONTEXT_DESC_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, SERVICES_CONTEXT_DESC_MAX - 1)}…`;
};

/** Normalize a successful list_services tool payload for checkpoint reuse. */
export const normalizeListServicesResult = (raw: string): ServicesContext | null => {
  const record = asJsonRecord(raw);
  if (!record || typeof record.error === "string" || !Array.isArray(record.list)) {
    return null;
  }

  const list: ServicesContext["list"] = [];
  for (const entry of record.list) {
    const row = asJsonRecord(entry);
    if (!row || typeof row.id !== "string" || typeof row.name !== "string") {
      continue;
    }
    list.push({
      id: row.id,
      name: row.name,
      ...(row.duration !== undefined && row.duration !== null ? { duration: Number(row.duration) } : {}),
      ...(typeof row.description === "string" && row.description.trim().length > 0
        ? { description: truncateServiceDescription(row.description) }
        : {}),
    });
  }

  const truncated = list.length > SERVICES_CONTEXT_MAX_ROWS;
  return {
    list: truncated ? list.slice(0, SERVICES_CONTEXT_MAX_ROWS) : list,
    ...(typeof record.total === "number" ? { total: record.total } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
};

/** Keep booking-relevant service fields; drop CRM audit metadata and empty description. */
const compactServiceRecord = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  const compact: Record<string, unknown> = {};

  if (typeof record.id === "string") {
    compact.id = record.id;
  }
  if (typeof record.name === "string") {
    compact.name = record.name;
  }
  if (record.duration !== undefined && record.duration !== null) {
    compact.duration = record.duration;
  }
  if (typeof record.description === "string" && record.description.trim().length > 0) {
    compact.description = record.description.trim();
  }

  return compact;
};

/** Compact search_entity cService payloads for LLM context. */
const compactListServicesResult = (result: unknown): unknown => {
  let value: unknown = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return result;
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.list)) {
    return result;
  }

  const compact: Record<string, unknown> = {
    list: record.list.map(compactServiceRecord),
  };
  if (typeof record.total === "number") {
    compact.total = record.total;
  }
  return compact;
};

/** Keep FAQ-relevant get_service fields; drop CRM audit and relation metadata. */
const compactGetServiceResult = (result: unknown): unknown => {
  let value: unknown = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return result;
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") {
    return result;
  }

  const compact: Record<string, unknown> = {};
  if (typeof record.name === "string") {
    compact.name = record.name;
  }
  if (typeof record.description === "string" && record.description.trim().length > 0) {
    compact.description = record.description.trim();
  }
  if (record.price !== undefined && record.price !== null) {
    compact.price = record.price;
  }
  if (typeof record.priceCurrency === "string") {
    compact.currency = record.priceCurrency;
  }
  if (record.priceUah !== undefined && record.priceUah !== null) {
    compact.priceUah = record.priceUah;
  }

  const names = record.medicationsNames;
  if (names && typeof names === "object" && !Array.isArray(names)) {
    const medications = Object.values(names as Record<string, unknown>).filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    if (medications.length > 0) {
      compact.medications = medications;
    }
  }

  return compact;
};

/** Shared by list_services tool. */
export const listServices = async (
  callTool: McpCallTool,
  limit = 200,
): Promise<string> => {
  try {
    const result = await callTool("search_entity", {
      entityType: "cService",
      select: ["id", "name", "duration", "description"],
      limit,
    });
    return toToolResult(compactListServicesResult(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
};

/** Shared by get_working_time tool; args are passed through to espocrm-mcp. */
export const getWorkingTime = async (
  callTool: McpCallTool,
  args: GetWorkingTimeArgs = {},
): Promise<string> => {
  try {
    const result = await callTool("get_working_time", args as Record<string, unknown>);
    return toToolResult(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
};

export const createReadTools = (options: ReadToolsOptions): StructuredToolInterface[] => {
  const { callTool, assignedUserId } = options;

  const listServicesTool = tool(
    async (input: { limit?: number }) => listServices(callTool, input.limit ?? 200),
    {
      name: "list_services",
      description:
        `List clinic services (cService) from EspoCRM: names and duration (no pricing — use get_service for prices). Reuse <${CONTEXT_TAGS.services}> in context when list[] already covers the patient's choice — call only when the block is missing or empty.`,
      schema: z.object({
        limit: z.number().int().min(1).max(200).optional().describe("Max services to return"),
      }),
    },
  );

  const getService = tool(
    async (input: { serviceId: string }) => {
      try {
        const result = await callTool("get_entity", {
          entityType: "cService",
          entityId: input.serviceId,
        });
        let entity: unknown = result;
        if (typeof entity === "string") {
          try {
            entity = JSON.parse(entity) as unknown;
          } catch {
            return toToolResult(result);
          }
        }
        if (entity && typeof entity === "object" && !Array.isArray(entity)) {
          const record = entity as Record<string, unknown>;
          const price = record.price;
          if (
            record.priceCurrency === "USD" &&
            typeof price === "number" &&
            Number.isFinite(price)
          ) {
            try {
              const response = await fetch(USD_UAH_URL);
              const json = (await response.json()) as { usd?: { uah?: unknown } };
              const rate = json.usd?.uah;
              if (typeof rate === "number" && Number.isFinite(rate)) {
                record.priceUah = Math.round(price * rate);
              }
            } catch {
              // Keep CRM entity unchanged when FX lookup fails.
            }
          }
        }
        return toToolResult(compactGetServiceResult(entity));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({ error: message });
      }
    },
    {
      name: "get_service",
      description: "Get a single clinic service by id from EspoCRM.",
      schema: z.object({
        serviceId: z.string().min(1).describe("cService entity id"),
      }),
    },
  );

  const getWorkingTimeTool = tool(
    async (input: GetWorkingTimeArgs) => {
      const hasSelector = Boolean(input.calendarId || input.userId || input.teamId);
      const args: GetWorkingTimeArgs = hasSelector
        ? input
        : { ...input, userId: assignedUserId };
      return getWorkingTime(callTool, args);
    },
    {
      name: "get_working_time",
      description:
        "Get EspoCRM working time calendars (weekday flags, time ranges, timezone). Defaults to the clinic assigned user when no calendarId/userId/teamId is given.",
      schema: z.object({
        calendarId: z.string().min(1).optional().describe("WorkingTimeCalendar ID"),
        userId: z.string().min(1).optional().describe("Resolve calendar from a user"),
        teamId: z.string().min(1).optional().describe("Resolve calendar from a team"),
        name: z.string().min(1).optional().describe("Filter calendars by name (contains)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max calendars when listing"),
        offset: z.number().int().min(0).optional().describe("Offset when listing"),
      }),
    },
  );

  return [listServicesTool, getService, getWorkingTimeTool];
};

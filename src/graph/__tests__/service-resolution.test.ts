import { describe, expect, it, vi } from "vitest";

import {
  fetchCompleteServiceCatalog,
  resolveServiceChange,
  type ServiceCatalogRow,
} from "../service-resolution.js";

const rows: ServiceCatalogRow[] = [
  { id: "svc-consult", name: "Консультація", duration: 30, description: "Primary visit" },
  { id: "svc-botox", name: "Botox", duration: 45 },
  { id: "svc-botox-face", name: "Botox Face", duration: 45 },
  { id: "svc-botox-neck", name: "Botox Neck", duration: 30 },
];

describe("fetchCompleteServiceCatalog", () => {
  it("paginates until collected rows reach total", async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 2);
      const page = rows.slice(offset, offset + limit);
      return JSON.stringify({ list: page, total: rows.length });
    });
    const catalog = await fetchCompleteServiceCatalog(callTool, { pageSize: 2 });
    expect(catalog.ok).toBe(true);
    if (catalog.ok) {
      expect(catalog.rows).toHaveLength(4);
      expect(callTool).toHaveBeenCalledTimes(2);
    }
  });

  it("fails closed when a full page arrives without total", async () => {
    const callTool = vi.fn(async () =>
      JSON.stringify({
        list: rows.slice(0, 2).map((row) => ({ id: row.id, name: row.name })),
      }),
    );
    const catalog = await fetchCompleteServiceCatalog(callTool, { pageSize: 2 });
    expect(catalog).toEqual({ ok: false, reason: "incomplete" });
  });

  it("fails closed when a page errors", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("CRM down");
    });
    const catalog = await fetchCompleteServiceCatalog(callTool);
    expect(catalog).toEqual({ ok: false, reason: "error" });
  });
});

describe("resolveServiceChange", () => {
  const listServices = async () => ({ ok: true as const, rows });

  it("returns exact name match when exactly one row matches", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "запиши на ботокс", query: "Botox" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => {
          throw new Error("should not call model for exact match");
        },
      },
    );
    expect(result).toEqual({
      type: "service_changed",
      service: { id: "svc-botox", name: "Botox", durationMinutes: 45, source: "catalog" },
      accepted: true,
    });
  });

  it("opens candidates when the model returns multiple allowlisted ids", async () => {
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "ботокс",
        noteCandidate: "I need a consultation regarding Botox",
      },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ["svc-botox-face", "svc-botox-neck"],
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботокс",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "svc-botox-face", label: "Botox Face" },
        { id: "svc-botox-neck", label: "Botox Neck" },
      ],
    });
  });

  it("rejects invented ids and returns unresolved", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "ботокс" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ["svc-invented"],
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });

  it("returns unresolved for an incomplete catalog", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "Botox" },
      {
        fetchCatalog: async () => ({ ok: false, reason: "incomplete" }),
        selectCandidates: async () => ["svc-botox"],
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });

  it("returns one semantic candidate when the model picks a single allowlisted id", async () => {
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "I need a consultation regarding Botox",
        query: "consultation",
        noteCandidate: "I need a consultation regarding Botox",
      },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ["svc-consult"],
      },
    );
    expect(result).toEqual({
      type: "service_changed",
      service: {
        id: "svc-consult",
        name: "Консультація",
        durationMinutes: 30,
        source: "catalog",
      },
      accepted: true,
      noteCandidate: "I need a consultation regarding Botox",
    });
  });

  it("returns unresolved when the model selects nothing", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "something unknown" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => [],
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });
});

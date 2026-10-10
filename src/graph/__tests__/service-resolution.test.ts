import { describe, expect, it, vi } from "vitest";

import { setTrackEventForTests } from "../../analytics/track.js";
import { SERVICE_CANDIDATE_OTHER_LABEL_UK } from "../../shared/clinic-constants.js";
import {
  SERVICE_CANDIDATE_PARTITION_INSTRUCTION,
  SERVICE_CANDIDATE_SELECTOR_INSTRUCTION,
  createServiceCandidatePartitioner,
  createServiceCandidateSelector,
  fetchCompleteServiceCatalog,
  partitionRemainingServiceChoices,
  resolveServiceChange,
  type ServiceCatalogRow,
} from "../service-resolution.js";
import type { ILLMConnector } from "../types.js";
import { buildFaqCatalogChoices } from "../faq-catalog.js";

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

describe("createServiceCandidateSelector instruction", () => {
  it("teaches one-level catalog groups without patient-voice FAQ copy", () => {
    expect(SERVICE_CANDIDATE_SELECTOR_INSTRUCTION).toContain(
      "Every selected id must appear in exactly one group",
    );
    expect(SERVICE_CANDIDATE_SELECTOR_INSTRUCTION).not.toContain("CATALOG SHORTCUTS");
    expect(SERVICE_CANDIDATE_SELECTOR_INSTRUCTION).not.toContain("the graph attaches");
    expect(SERVICE_CANDIDATE_SELECTOR_INSTRUCTION).not.toContain("Записати вас на консультацію");
    expect(SERVICE_CANDIDATE_PARTITION_INSTRUCTION).toContain("Partition the given clinic service ids");
    expect(SERVICE_CANDIDATE_PARTITION_INSTRUCTION).not.toContain("Prefer fewer ids");
  });

  it("binds the groups schema through the LLM connector", async () => {
    const invoke = vi.fn(async () => ({
      serviceIds: ["svc-botox-face", "svc-botox-neck"],
      groups: [
        { label: "обличчя", serviceIds: ["svc-botox-face"] },
        { label: "шия", serviceIds: ["svc-botox-neck"] },
      ],
    }));
    const bindRoutingTools = vi.fn(() => ({ invoke }));
    const select = createServiceCandidateSelector({
      bindRoutingTools,
    } as unknown as ILLMConnector);
    const result = await select({
      utterance: "ботокс",
      candidates: rows.map((row) => ({ id: row.id, name: row.name })),
    });
    expect(bindRoutingTools).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "select_service_candidates" }),
    );
    expect(result).toEqual({
      serviceIds: ["svc-botox-face", "svc-botox-neck"],
      groups: [
        { label: "обличчя", serviceIds: ["svc-botox-face"] },
        { label: "шия", serviceIds: ["svc-botox-neck"] },
      ],
    });
  });

  it("binds a partition-only schema for remaining-id drill-down", async () => {
    const invoke = vi.fn(async () => ({
      groups: [
        { label: "обличчя", serviceIds: ["svc-botox-face"] },
        { label: "шия", serviceIds: ["svc-botox-neck"] },
      ],
    }));
    const bindRoutingTools = vi.fn(() => ({ invoke }));
    const partition = createServiceCandidatePartitioner({
      bindRoutingTools,
    } as unknown as ILLMConnector);
    const result = await partition({
      utterance: "ботокс",
      candidates: [
        { id: "svc-botox-face", name: "Botox Face" },
        { id: "svc-botox-neck", name: "Botox Neck" },
      ],
    });
    expect(bindRoutingTools).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "partition_service_candidates" }),
    );
    expect(result).toEqual([
      { label: "обличчя", serviceIds: ["svc-botox-face"] },
      { label: "шия", serviceIds: ["svc-botox-neck"] },
    ]);
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

  it("labels singleton groups with CRM names and keeps multi-id partition labels", async () => {
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "ботокс",
        noteCandidate: "I need a consultation regarding Botox",
      },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({
          serviceIds: ["svc-botox-face", "svc-botox-neck", "svc-botox"],
          groups: [
            {
              label: "зони",
              serviceIds: ["svc-botox-face", "svc-botox-neck"],
            },
            { label: "базовий", serviceIds: ["svc-botox"] },
          ],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботокс",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        {
          id: "g0",
          label: "зони",
          serviceIds: ["svc-botox-face", "svc-botox-neck"],
        },
        { id: "svc-botox", label: "Botox", serviceIds: ["svc-botox"] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("базовий");
    expect(JSON.stringify(result)).not.toContain("Botox Face");
    expect(JSON.stringify(result)).not.toContain("Botox Neck");
  });

  it("replaces an abstract singleton partition label with the CRM service name", async () => {
    // No exact CRM row named «Консультація» — mirrors the live catalog that forced grouping.
    const catalogRows: ServiceCatalogRow[] = [
      { id: "svc-weight", name: "Схуднення консультація", duration: 30 },
      { id: "svc-consult-primary", name: "Консультація первинна", duration: 30 },
      { id: "svc-consult-repeat", name: "Консультація повторна", duration: 30 },
      { id: "svc-botox", name: "Botox", duration: 45 },
    ];
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "консультація" },
      {
        fetchCatalog: async () => ({ ok: true as const, rows: catalogRows }),
        selectCandidates: async () => ({
          serviceIds: ["svc-consult-primary", "svc-consult-repeat", "svc-weight"],
          groups: [
            {
              label: "Консультації",
              serviceIds: ["svc-consult-primary", "svc-consult-repeat"],
            },
            { label: "Спеціалізовані", serviceIds: ["svc-weight"] },
          ],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "консультація",
      choices: [
        {
          id: "g0",
          label: "Консультації",
          serviceIds: ["svc-consult-primary", "svc-consult-repeat"],
        },
        {
          id: "svc-weight",
          label: "Схуднення консультація",
          serviceIds: ["svc-weight"],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Спеціалізовані");
  });

  it("falls back to per-id CRM chips when one group covers the whole set", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "ботокс" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({
          serviceIds: ["svc-botox-face", "svc-botox-neck", "svc-botox"],
          groups: [
            {
              label: "ботулінотерапія",
              serviceIds: ["svc-botox-face", "svc-botox-neck", "svc-botox"],
            },
          ],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботокс",
      choices: [
        { id: "svc-botox-face", label: "Botox Face", serviceIds: ["svc-botox-face"] },
        { id: "svc-botox-neck", label: "Botox Neck", serviceIds: ["svc-botox-neck"] },
        { id: "svc-botox", label: "Botox", serviceIds: ["svc-botox"] },
      ],
    });
  });

  it("rejects invented ids and returns unresolved", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "ботокс" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({ serviceIds: ["svc-invented"] }),
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });

  it("returns unresolved and emits tool_error when selectCandidates rejects", async () => {
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    setTrackEventForTests((name, props) => {
      events.push({ name, props });
    });
    try {
      const result = await resolveServiceChange(
        { type: "resolve_service", utterance: "ботокс" },
        {
          fetchCatalog: listServices,
          selectCandidates: async () => {
            throw new Error("model unavailable");
          },
        },
      );
      expect(result).toEqual({ type: "service_unresolved" });
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "tool_error",
          props: expect.objectContaining({
            tool: "select_service_candidates",
            error_message: expect.stringContaining("model unavailable"),
          }),
        }),
      );
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("falls back to per-id CRM chips when groups are missing for multiple ids", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "ботокс" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({
          serviceIds: ["svc-botox-face", "svc-botox-neck"],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботокс",
      choices: [
        { id: "svc-botox-face", label: "Botox Face", serviceIds: ["svc-botox-face"] },
        { id: "svc-botox-neck", label: "Botox Neck", serviceIds: ["svc-botox-neck"] },
      ],
    });
  });

  it("preserves partial valid groups and parks uncovered ids under Інші варіанти", async () => {
    const catalogRows: ServiceCatalogRow[] = [
      ...rows,
      { id: "svc-nabota", name: "Nabota Face", duration: 45 },
      { id: "svc-correction", name: "Корекція ботокс", duration: 30 },
      { id: "svc-meso", name: "Мезоботокс", duration: 30 },
    ];
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "запиши на ботокс",
        query: "ботокс",
      },
      {
        fetchCatalog: async () => ({ ok: true as const, rows: catalogRows }),
        selectCandidates: async () => ({
          // Trace-shaped: 16 selected in prod; here 5 allowlisted + 1 invented.
          serviceIds: [
            "svc-botox-face",
            "svc-botox-neck",
            "svc-nabota",
            "svc-correction",
            "svc-meso",
            "svc-invented",
          ],
          groups: [
            {
              label: "Botox/Disport",
              serviceIds: ["svc-botox-face", "svc-botox-neck"],
            },
            { label: "Nabota", serviceIds: ["svc-nabota"] },
            // Корекція ботокс + Мезоботокс left uncovered by the model.
          ],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "запиши на ботокс",
      query: "ботокс",
      choices: [
        {
          id: "g0",
          label: "Botox/Disport",
          serviceIds: ["svc-botox-face", "svc-botox-neck"],
        },
        { id: "svc-nabota", label: "Nabota Face", serviceIds: ["svc-nabota"] },
        {
          id: "g2",
          label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
          serviceIds: ["svc-correction", "svc-meso"],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Корекція ботокс");
    expect(JSON.stringify(result)).not.toContain("Мезоботокс");
    expect(JSON.stringify(result)).not.toContain("svc-invented");
  });

  it("falls back to per-id CRM chips when every group id is invented", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "ботокс" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({
          serviceIds: ["svc-botox-face", "svc-botox-neck"],
          groups: [
            { label: "fake", serviceIds: ["svc-invented-a", "svc-invented-b"] },
          ],
        }),
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботокс",
      choices: [
        { id: "svc-botox-face", label: "Botox Face", serviceIds: ["svc-botox-face"] },
        { id: "svc-botox-neck", label: "Botox Neck", serviceIds: ["svc-botox-neck"] },
      ],
    });
  });

  it("returns unresolved for an incomplete catalog", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "Botox" },
      {
        fetchCatalog: async () => ({ ok: false, reason: "incomplete" }),
        selectCandidates: async () => ({ serviceIds: ["svc-botox"] }),
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });

  it("exact-matches a Ukrainian consultation query without calling the selector", async () => {
    const selectCandidates = vi.fn(async () => {
      throw new Error("should not call selector for an exact catalog name");
    });
    const noteCandidate = "нужна консультация по ботоксу";
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: noteCandidate,
        query: "Консультація",
        noteCandidate,
      },
      {
        fetchCatalog: listServices,
        selectCandidates,
      },
    );
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "service_changed",
      service: {
        id: "svc-consult",
        name: "Консультація",
        durationMinutes: 30,
        source: "catalog",
      },
      accepted: true,
      noteCandidate,
    });
  });

  it("calls the selector with the query probe, not the original utterance", async () => {
    const selectCandidates = vi.fn(async (input: {
      utterance: string;
      query?: string;
      candidates: Array<{ id: string }>;
    }) => {
      expect(input.utterance).toBe("неотіва");
      expect(input.query).toBeUndefined();
      expect(input.candidates.map((row) => row.id)).toContain("svc-botox");
      return { serviceIds: ["svc-botox"] };
    });
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "запиши на неотіву замість ботоксу",
        query: "неотіва",
        noteCandidate: "запиши на неотіву замість ботоксу",
      },
      {
        fetchCatalog: listServices,
        selectCandidates,
      },
    );
    expect(selectCandidates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      type: "service_changed",
      service: {
        id: "svc-botox",
        name: "Botox",
        durationMinutes: 45,
        source: "catalog",
      },
      accepted: true,
      noteCandidate: "запиши на неотіву замість ботоксу",
    });
  });

  it("returns unresolved when the model selects nothing", async () => {
    const result = await resolveServiceChange(
      { type: "resolve_service", utterance: "something unknown" },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({ serviceIds: [] }),
      },
    );
    expect(result).toEqual({ type: "service_unresolved" });
  });

  it("partitions remainingIds without re-filtering the full catalog", async () => {
    const selectCandidates = vi.fn(async () => {
      throw new Error("should not filter when partitionCandidates is provided");
    });
    const partitionCandidates = vi.fn(async (input: {
      utterance: string;
      query?: string;
      candidates: Array<{ id: string }>;
    }) => {
      expect(input.utterance).toBe("ботулінотерапія");
      expect(input.query).toBeUndefined();
      expect(input.candidates.map((row) => row.id).sort()).toEqual([
        "svc-botox-face",
        "svc-botox-neck",
      ]);
      return [
        { label: "обличчя", serviceIds: ["svc-botox-face"] },
        { label: "шия", serviceIds: ["svc-botox-neck"] },
      ];
    });
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "хочу змінити на ботулінотерапію обличчя чи шиї",
        query: "ботулінотерапія",
        remainingIds: ["svc-botox-face", "svc-botox-neck"],
      },
      {
        fetchCatalog: listServices,
        selectCandidates,
        partitionCandidates,
      },
    );
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(partitionCandidates).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      type: "service_candidates_opened",
      utterance: "хочу змінити на ботулінотерапію обличчя чи шиї",
      query: "ботулінотерапія",
      choices: [
        { id: "svc-botox-face", label: "Botox Face", serviceIds: ["svc-botox-face"] },
        { id: "svc-botox-neck", label: "Botox Neck", serviceIds: ["svc-botox-neck"] },
      ],
    });
  });

  it("falls back to per-id chips when remainingIds partition does not shrink", async () => {
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "ботулінотерапія",
        remainingIds: ["svc-botox-face", "svc-botox-neck"],
      },
      {
        fetchCatalog: listServices,
        selectCandidates: async () => ({ serviceIds: [] }),
        partitionCandidates: async () => [
          {
            label: "ботулінотерапія",
            serviceIds: ["svc-botox-face", "svc-botox-neck"],
          },
        ],
      },
    );
    expect(result).toEqual({
      type: "service_candidates_opened",
      utterance: "ботулінотерапія",
      choices: [
        { id: "svc-botox-face", label: "Botox Face", serviceIds: ["svc-botox-face"] },
        { id: "svc-botox-neck", label: "Botox Neck", serviceIds: ["svc-botox-neck"] },
      ],
    });
  });

  it("applies a single remainingId without calling the selector", async () => {
    const selectCandidates = vi.fn(async () => {
      throw new Error("should not call selector for one remaining id");
    });
    const result = await resolveServiceChange(
      {
        type: "resolve_service",
        utterance: "обличчя",
        remainingIds: ["svc-botox-face"],
      },
      {
        fetchCatalog: listServices,
        selectCandidates,
      },
    );
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "service_changed",
      service: {
        id: "svc-botox-face",
        name: "Botox Face",
        durationMinutes: 45,
        source: "catalog",
      },
      accepted: true,
    });
  });
});

describe("partitionRemainingServiceChoices", () => {
  it("returns shrinking partition groups as InteractionChoice chips", async () => {
    const choices = await partitionRemainingServiceChoices({
      rows,
      utterance: "Обрати іншу процедуру",
      partitionCandidates: async () => [
        { label: "Консультація", serviceIds: ["svc-consult"] },
        { label: "Ботокс", serviceIds: ["svc-botox", "svc-botox-face", "svc-botox-neck"] },
      ],
    });
    expect(choices).toEqual([
      {
        id: "svc-consult",
        label: "Консультація",
        serviceIds: ["svc-consult"],
      },
      {
        id: "g1",
        label: "Ботокс",
        serviceIds: ["svc-botox", "svc-botox-face", "svc-botox-neck"],
      },
    ]);
  });

  it("returns empty when partition does not shrink (caller uses CRM fallback)", async () => {
    const choices = await partitionRemainingServiceChoices({
      rows: [rows[2]!, rows[3]!],
      utterance: "ботулінотерапія",
      partitionCandidates: async () => [
        {
          label: "ботулінотерапія",
          serviceIds: ["svc-botox-face", "svc-botox-neck"],
        },
      ],
    });
    expect(choices).toEqual([]);
  });

  it("returns empty and emits tool_error when the partitioner rejects", async () => {
    const events: Array<{ name: string; props: Record<string, unknown> }> = [];
    setTrackEventForTests((name, props) => {
      events.push({ name, props });
    });
    try {
      const choices = await partitionRemainingServiceChoices({
        rows,
        utterance: "Обрати іншу процедуру",
        partitionCandidates: async () => {
          throw new Error("network down");
        },
      });
      expect(choices).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "tool_error",
          props: expect.objectContaining({
            tool: "partition_service_candidates",
            error_message: expect.stringContaining("network down"),
          }),
        }),
      );
    } finally {
      setTrackEventForTests(null);
    }
  });
});

describe("buildFaqCatalogChoices overflow", () => {
  it("parks services after the first page under Інші варіанти", () => {
    const services = Array.from({ length: 9 }, (_, index) => ({
      id: `svc-${index + 1}`,
      name: `Service ${index + 1}`,
    }));
    const choices = buildFaqCatalogChoices(services);
    expect(choices).toHaveLength(8);
    expect(choices.slice(0, 7).map((c) => c.id)).toEqual([
      "svc-1", "svc-2", "svc-3", "svc-4", "svc-5", "svc-6", "svc-7",
    ]);
    expect(choices[7]).toEqual({
      id: "faq_other",
      label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
      serviceIds: ["svc-8", "svc-9"],
    });
  });

  it("returns all rows when eight or fewer", () => {
    const services = Array.from({ length: 8 }, (_, index) => ({
      id: `svc-${index + 1}`,
      name: `Service ${index + 1}`,
    }));
    const choices = buildFaqCatalogChoices(services);
    expect(choices).toHaveLength(8);
    expect(choices.every((c) => c.serviceIds?.length === 1)).toBe(true);
    expect(choices.some((c) => c.label === SERVICE_CANDIDATE_OTHER_LABEL_UK)).toBe(false);
  });
});

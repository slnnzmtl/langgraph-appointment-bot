import { describe, expect, it, beforeEach, vi } from "vitest";

import { createReadTools, getWorkingTime, listServices, normalizeListServicesResult } from "../service-tools.js";

type CallRecord = { name: string; args: Record<string, unknown> };

describe("normalizeListServicesResult", () => {
  it("parses compact list_services payloads", () => {
    expect(
      normalizeListServicesResult(
        JSON.stringify({
          total: 2,
          list: [
            { id: "svc-1", name: "Консультація", duration: 30 },
            { id: "svc-2", name: "Біоревіталізація", duration: 60, description: "Neuvia" },
          ],
        }),
      ),
    ).toEqual({
      total: 2,
      list: [
        { id: "svc-1", name: "Консультація", duration: 30 },
        { id: "svc-2", name: "Біоревіталізація", duration: 60, description: "Neuvia" },
      ],
    });
  });

  it("returns null for error payloads", () => {
    expect(normalizeListServicesResult(JSON.stringify({ error: "CRM down" }))).toBeNull();
  });

  it("returns null for unparseable payloads", () => {
    expect(normalizeListServicesResult("not json")).toBeNull();
  });
});

describe("service-tools", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { ok: true };
  };

  it("listServices calls search_entity for cService with default limit", async () => {
    const result = await listServices(callTool);
    expect(calls[0]).toEqual({
      name: "search_entity",
      args: {
        entityType: "cService",
        select: ["id", "name", "duration", "description"],
        limit: 200,
      },
    });
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("listServices respects custom limit", async () => {
    await listServices(callTool, 10);
    expect(calls[0]).toEqual({
      name: "search_entity",
      args: {
        entityType: "cService",
        select: ["id", "name", "duration", "description"],
        limit: 10,
      },
    });
  });

  it("listServices returns error JSON when callTool throws", async () => {
    const failing = async () => {
      throw new Error("MCP down");
    };
    const result = await listServices(failing);
    expect(JSON.parse(result)).toEqual({ error: "MCP down" });
  });

  it("listServices compacts CRM metadata from service list", async () => {
    const callTool = async () => ({
      success: true,
      entityType: "cService",
      total: 3,
      list: [
        {
          id: "svc-1",
          name: "Консультація",
          deleted: false,
          description: null,
          createdAt: "2025-05-28 23:36:44",
          modifiedAt: "2026-08-06 23:15:58",
          price: 400,
          workPrice: null,
          duration: 30,
          priceCurrency: "UAH",
          createdById: "u-1",
          createdByName: "Admin",
          modifiedById: null,
          modifiedByName: null,
          assignedUserId: null,
          assignedUserName: null,
          priceConverted: null,
        },
        {
          id: "svc-2",
          name: "Біоревіталізація",
          deleted: false,
          description: "  Neuvia hydro delux  ",
          createdAt: "2025-05-21 15:59:55",
          modifiedAt: "2026-01-03 14:03:33",
          price: 100,
          duration: 60,
          priceCurrency: "USD",
          priceConverted: 100,
        },
        {
          id: "svc-3",
          name: "Пілінг",
          description: "",
          createdAt: "2025-05-21 15:59:54",
          price: 1200,
          duration: 60,
          priceCurrency: "UAH",
        },
      ],
    });

    const parsed = JSON.parse(await listServices(callTool)) as {
      total: number;
      list: Array<Record<string, unknown>>;
    };
    expect(parsed).toEqual({
      total: 3,
      list: [
        {
          id: "svc-1",
          name: "Консультація",
          duration: 30,
        },
        {
          id: "svc-2",
          name: "Біоревіталізація",
          duration: 60,
          description: "Neuvia hydro delux",
        },
        {
          id: "svc-3",
          name: "Пілінг",
          duration: 60,
        },
      ],
    });
  });

  it("getWorkingTime calls get_working_time MCP tool", async () => {
    const result = await getWorkingTime(callTool, { userId: "user-1" });
    expect(calls[0]).toEqual({
      name: "get_working_time",
      args: { userId: "user-1" },
    });
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("getWorkingTime returns error JSON when callTool throws", async () => {
    const failing = async () => {
      throw new Error("MCP down");
    };
    const result = await getWorkingTime(failing, { userId: "user-1" });
    expect(JSON.parse(result)).toEqual({ error: "MCP down" });
  });

  it("read tools expose list_services, get_service, and get_working_time", () => {
    const names = createReadTools({ callTool, assignedUserId: "assigned-1" }).map((t) => t.name);
    expect(names).toEqual(["list_services", "get_service", "get_working_time"]);
  });

  it("get_working_time defaults to assignedUserId when no selector given", async () => {
    const [tool] = createReadTools({ callTool, assignedUserId: "assigned-99" }).filter(
      (t) => t.name === "get_working_time",
    );
    await tool!.invoke({});
    expect(calls[0]).toEqual({
      name: "get_working_time",
      args: { userId: "assigned-99" },
    });
  });

  it("get_working_time respects explicit userId", async () => {
    const [tool] = createReadTools({ callTool, assignedUserId: "assigned-99" }).filter(
      (t) => t.name === "get_working_time",
    );
    await tool!.invoke({ userId: "other-user" });
    expect(calls[0]).toEqual({
      name: "get_working_time",
      args: { userId: "other-user" },
    });
  });

  it("get_service calls get_entity for cService", async () => {
    const [tool] = createReadTools({ callTool, assignedUserId: "assigned-1" }).filter(
      (t) => t.name === "get_service",
    );
    await tool!.invoke({ serviceId: "svc-1" });
    expect(calls[0]).toEqual({
      name: "get_entity",
      args: { entityType: "cService", entityId: "svc-1" },
    });
  });

  it("get_service returns error JSON when callTool throws", async () => {
    const failing = async () => {
      throw new Error("MCP down");
    };
    const [tool] = createReadTools({ callTool: failing, assignedUserId: "assigned-1" }).filter(
      (t) => t.name === "get_service",
    );
    const result = await tool!.invoke({ serviceId: "svc-1" });
    expect(JSON.parse(result)).toEqual({ error: "MCP down" });
  });

  it("get_service keeps name, description, price, currency, and medications", async () => {
    const sampleCallTool = async () => ({
      success: true,
      entityType: "cService",
      id: "682dce4ae0d096ea3",
      name: "Ботулінотерапія Nabota FULL FACE",
      deleted: false,
      description: "  Full-face botox  ",
      createdAt: "2025-05-21 15:59:54",
      modifiedAt: "2026-01-03 15:44:24",
      price: 200,
      workPrice: null,
      duration: 45,
      priceCurrency: "USD",
      createdById: "682dcd0dc0406e042",
      createdByName: "Admin",
      modifiedById: "682dd2ab4e415283d",
      modifiedByName: "Kate Fedchenko",
      assignedUserId: null,
      assignedUserName: null,
      teamsIds: [],
      teamsNames: {},
      priceConverted: 200,
      opportunitiesIds: ["68d90f6274974711e"],
      opportunitiesNames: { "68d90f6274974711e": "Виктория клиентка" },
      medicationsIds: ["med-1", "med-2"],
      medicationsNames: { "med-1": "Nabota", "med-2": "Lidocaine" },
      meetingsIds: ["6a265e62f00451848"],
      meetingsNames: {
        "6a265e62f00451848": "Виктория Заволока - Ботулінотерапія Nabota FULL FACE",
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ usd: { uah: 41.2 } }),
    })) as typeof fetch;

    try {
      const [tool] = createReadTools({
        callTool: sampleCallTool,
        assignedUserId: "assigned-1",
      }).filter((t) => t.name === "get_service");
      const parsed = JSON.parse(await tool!.invoke({ serviceId: "682dce4ae0d096ea3" })) as Record<
        string,
        unknown
      >;
      expect(parsed).toEqual({
        name: "Ботулінотерапія Nabota FULL FACE",
        description: "Full-face botox",
        price: 200,
        currency: "USD",
        priceUah: 8240,
        medications: ["Nabota", "Lidocaine"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("get_service omits empty description and medications", async () => {
    const sampleCallTool = async () => ({
      success: true,
      entityType: "cService",
      id: "682dce4ae0d096ea3",
      name: "Ботулінотерапія Nabota FULL FACE",
      deleted: false,
      description: null,
      createdAt: "2025-05-21 15:59:54",
      modifiedAt: "2026-01-03 15:44:24",
      price: 200,
      workPrice: null,
      duration: 45,
      priceCurrency: "USD",
      createdById: "682dcd0dc0406e042",
      createdByName: "Admin",
      opportunitiesIds: ["68d90f6274974711e"],
      opportunitiesNames: { "68d90f6274974711e": "Виктория клиентка" },
      medicationsIds: [],
      medicationsNames: {},
      meetingsIds: ["6a265e62f00451848"],
      meetingsNames: {
        "6a265e62f00451848": "Виктория Заволока - Ботулінотерапія Nabota FULL FACE",
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ usd: { uah: 41.2 } }),
    })) as typeof fetch;

    try {
      const [tool] = createReadTools({
        callTool: sampleCallTool,
        assignedUserId: "assigned-1",
      }).filter((t) => t.name === "get_service");
      const parsed = JSON.parse(await tool!.invoke({ serviceId: "682dce4ae0d096ea3" })) as Record<
        string,
        unknown
      >;
      expect(parsed).toEqual({
        name: "Ботулінотерапія Nabota FULL FACE",
        price: 200,
        currency: "USD",
        priceUah: 8240,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("get_service attaches priceUah for USD services", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ usd: { uah: 41.2 } }),
    })) as typeof fetch;

    try {
      const usdCallTool = async () => ({
        id: "svc-2",
        name: "Біоревіталізація",
        price: 100,
        priceCurrency: "USD",
      });
      const [tool] = createReadTools({ callTool: usdCallTool, assignedUserId: "assigned-1" }).filter(
        (t) => t.name === "get_service",
      );
      const parsed = JSON.parse(await tool!.invoke({ serviceId: "svc-2" })) as Record<
        string,
        unknown
      >;
      expect(parsed.priceUah).toBe(4120);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("get_service does not fetch FX for UAH services", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const uahCallTool = async () => ({
        id: "svc-1",
        name: "Консультація",
        price: 400,
        priceCurrency: "UAH",
      });
      const [tool] = createReadTools({ callTool: uahCallTool, assignedUserId: "assigned-1" }).filter(
        (t) => t.name === "get_service",
      );
      const parsed = JSON.parse(await tool!.invoke({ serviceId: "svc-1" })) as Record<
        string,
        unknown
      >;
      expect(parsed.priceUah).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

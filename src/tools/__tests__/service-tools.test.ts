import { describe, expect, it, beforeEach } from "vitest";

import { createReadTools, getWorkingTime, listServices } from "../service-tools.js";

type CallRecord = { name: string; args: Record<string, unknown> };

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
      args: { entityType: "cService", limit: 50 },
    });
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("listServices respects custom limit", async () => {
    await listServices(callTool, 10);
    expect(calls[0]).toEqual({
      name: "search_entity",
      args: { entityType: "cService", limit: 10 },
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
          price: 400,
          duration: 30,
          priceCurrency: "UAH",
        },
        {
          id: "svc-2",
          name: "Біоревіталізація",
          price: 100,
          duration: 60,
          priceCurrency: "USD",
          description: "Neuvia hydro delux",
        },
        {
          id: "svc-3",
          name: "Пілінг",
          price: 1200,
          duration: 60,
          priceCurrency: "UAH",
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
});

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import { compileClinicGraph, prefetchBookingContext } from "../compile.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";

describe("prefetchBookingContext", () => {
  it("chains contact lookup then planned meetings", async () => {
    const names: string[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name, args) => {
        names.push(name);
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        expect(name).toBe("search_entity");
        expect(args).toMatchObject({
          entityType: "Meeting",
          filters: { parentId: "c-1", parentType: "Contact", status: "Planned" },
        });
        return {
          list: [
            {
              id: "m-1",
              name: "Consult",
              dateStart: "2026-08-17 11:00:00",
              dateEnd: "2026-08-17 11:30:00",
            },
          ],
        };
      }),
    );

    expect(names).toEqual(["search_contacts", "search_entity"]);
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] },
    ]);
    expect(result.bookingContext?.meetings).toEqual([
      {
        id: "m-1",
        name: "Consult",
        dateStart: "2026-08-17 11:00:00",
        dateEnd: "2026-08-17 11:30:00",
      },
    ]);
  });

  it("sets contactContext when no contact id and skips meetings lookup", async () => {
    const names: string[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        names.push(name);
        return { success: true, contacts: [] };
      }),
    );
    expect(names).toEqual(["search_contacts"]);
    expect(result.contactContext).toEqual({ contacts: [] });
    expect(result.bookingContext).toBeNull();
  });

  it("keeps contactContext when meetings lookup fails", async () => {
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1" }] };
        }
        throw new Error("CRM down");
      }),
    );
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", missingFields: ["firstName", "lastName", "phoneNumber"] },
    ]);
    expect(result.bookingContext).toBeNull();
  });
});

const bookingAgent: ClinicAgentDefinition = {
  id: "booking",
  name: "Booking",
  description: "Booking",
  systemPrompt: "booking",
  maxSteps: 10,
};

describe("compileClinicGraph prefetch once", () => {
  const compileWithCallTool = (
    callTool: (name: string) => Promise<unknown>,
    extra?: { prefetchTtlMs?: number },
  ) =>
    compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [] },
      agentModel: {
        bindTools: () => ({
          invoke: async () => new AIMessage("ok"),
        }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
      bookingPrefetchCallTool: callTool,
      ...(extra?.prefetchTtlMs != null ? { prefetchTtlMs: extra.prefetchTtlMs } : {}),
    });

  it("supervisor prefetches once per booking turn; prepare does not", async () => {
    const names: string[] = [];
    const { graph } = compileWithCallTool(async (name) => {
      names.push(name);
      if (name === "search_contacts") {
        return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
      }
      return { list: [] };
    });

    await runWithTelegramUserId("tg-1", () =>
      graph.invoke(
        { messages: [new HumanMessage("book")] } as never,
        { configurable: { thread_id: "t1" } },
      ),
    );

    expect(names.filter((n) => n === "search_contacts")).toHaveLength(1);
    expect(names.filter((n) => n === "search_entity")).toHaveLength(1);
  });

  it("reuses checkpointed prefetch on the next turn within TTL", async () => {
    const names: string[] = [];
    const { graph } = compileWithCallTool(async (name) => {
      names.push(name);
      if (name === "search_contacts") {
        return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
      }
      return { list: [] };
    });

    await runWithTelegramUserId("tg-1", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("book")] } as never,
        { configurable: { thread_id: "t1" } },
      );
      await graph.invoke(
        { messages: [new HumanMessage("tomorrow")] } as never,
        { configurable: { thread_id: "t1" } },
      );
    });

    expect(names.filter((n) => n === "search_contacts")).toHaveLength(1);
    expect(names.filter((n) => n === "search_entity")).toHaveLength(1);
  });

  it("refetches on the next turn when TTL is zero", async () => {
    const names: string[] = [];
    const { graph } = compileWithCallTool(
      async (name) => {
        names.push(name);
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        return { list: [] };
      },
      { prefetchTtlMs: 0 },
    );

    await runWithTelegramUserId("tg-1", async () => {
      await graph.invoke(
        { messages: [new HumanMessage("book")] } as never,
        { configurable: { thread_id: "t1" } },
      );
      await graph.invoke(
        { messages: [new HumanMessage("tomorrow")] } as never,
        { configurable: { thread_id: "t1" } },
      );
    });

    expect(names.filter((n) => n === "search_contacts")).toHaveLength(2);
    expect(names.filter((n) => n === "search_entity")).toHaveLength(2);
  });
});

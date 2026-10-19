import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Command, interrupt } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { interpretInvokeResult } from "../../adapter/telegram-outbound.js";
import {
  MAIN_MENU_LABEL,
  type ReplyKeyboardMarkup,
} from "../../adapter/telegram-ui.js";
import { resumeConfirmBookingHitl } from "../../composition/booking-hitl.js";
import { clearPendingConfirmsForTests } from "../../tools/meeting-confirm.js";
import { createMeetingTools } from "../../tools/meeting-tools.js";
import { createContactTools } from "../../tools/contact-tools.js";
import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import { compileClinicGraph, prefetchBookingContext } from "../compile.js";
import {
  BOOKING_CONTACT_SAVE_FAILED_UK,
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_PHONE_QUESTION_UK,
  BOOKING_REPLACE_MENU,
  BOOKING_SCHEDULE_RESELECT_UK,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  RETURN_TO_BOOKING_LABEL_UK,
  SERVICE_CHANGE_ACK_UK,
  SERVICE_CANDIDATE_OTHER_LABEL_UK,
  SERVICE_OR_NOTE_KEEP_LABEL_UK,
  SERVICE_OR_NOTE_SWITCH_LABEL_UK,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";

afterEach(() => {
  clearPendingConfirmsForTests();
});

describe("prefetchBookingContext", () => {
  it("chains contact lookup, planned meetings, then latest Held", async () => {
    const names: string[] = [];
    const entityFilters: unknown[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name, args) => {
        names.push(name);
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        expect(name).toBe("search_entity");
        entityFilters.push(args?.filters);
        const statusIn = (args?.filters as { status?: { $in?: string[] } } | undefined)?.status
          ?.$in;
        if (statusIn?.includes("Held")) {
          return {
            list: [
              {
                id: "h-1",
                name: "Past Consult",
                dateStart: "2026-06-01 10:00:00",
                dateEnd: "2026-06-01 10:30:00",
                status: "Held",
              },
            ],
          };
        }
        expect(args).toMatchObject({
          entityType: "Meeting",
          filters: {
            parentId: "c-1",
            parentType: "Contact",
            status: { $in: ["Planned", "Confirmed"] },
          },
        });
        return {
          list: [
            {
              id: "m-1",
              name: "Consult",
              dateStart: "2027-01-15 11:00:00",
              dateEnd: "2027-01-15 11:30:00",
            },
          ],
        };
      }),
    );

    expect(names).toEqual(["search_contacts", "search_entity", "search_entity"]);
    expect(entityFilters[1]).toMatchObject({
      parentId: "c-1",
      status: { $in: ["Held"] },
    });
    expect(entityFilters[1]).not.toHaveProperty("dateStart");
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] },
    ]);
    expect(result.contactContext.ownership).toBe("telegram");
    expect(result.bookingContext?.meetings).toEqual([
      {
        id: "m-1",
        name: "Consult",
        dateStart: "2027-01-15 11:00:00",
        dateEnd: "2027-01-15 11:30:00",
      },
    ]);
    expect(result.bookingContext?.latestHeld).toEqual({
      id: "h-1",
      name: "Past Consult",
      dateStart: "2026-06-01 10:00:00",
      dateEnd: "2026-06-01 10:30:00",
    });
  });

  it("sets latestHeld null when there is no Held history", async () => {
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        return { list: [] };
      }),
    );
    expect(result.bookingContext).toEqual({
      meetings: [],
      dateFrom: expect.any(String),
      latestHeld: null,
    });
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

  it("keeps contactContext when planned meetings lookup fails", async () => {
    const names: string[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        names.push(name);
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1" }] };
        }
        throw new Error("CRM down");
      }),
    );
    expect(names).toEqual(["search_contacts", "search_entity"]);
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", missingFields: ["firstName", "lastName", "phoneNumber"] },
    ]);
    expect(result.bookingContext).toBeNull();
  });

  it("keeps upcoming meetings when Held lookup fails", async () => {
    let entityCalls = 0;
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        entityCalls += 1;
        if (entityCalls === 1) {
          return {
            list: [
              {
                id: "m-1",
                name: "Consult",
                dateStart: "2027-01-15 11:00:00",
                dateEnd: "2027-01-15 11:30:00",
              },
            ],
          };
        }
        throw new Error("Held search down");
      }),
    );
    expect(result.bookingContext?.meetings).toHaveLength(1);
    expect(result.bookingContext?.latestHeld).toBeNull();
  });
});

const bookingAgent: ClinicAgentDefinition = {
  id: "booking",
  name: "Booking",
  description: "Booking",
  systemPrompt: "booking",
  maxSteps: 10,
};

const faqAgent: ClinicAgentDefinition = {
  id: "faq",
  name: "FAQ",
  description: "FAQ",
  systemPrompt: "faq",
  maxSteps: 10,
};

describe("compileClinicGraph prefetch once", () => {
  // Bound ToolNode must include runtime tools the planner can stamp; an empty
  // allowlist strips them and re-injects forever (DDD-268 allowlist-first).
  const bookingRuntimeStubs = [
    tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "availability",
        schema: z.object({
          direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        }),
      },
    ),
  ];

  const compileWithCallTool = (
    callTool: (name: string) => Promise<unknown>,
    extra?: {
      prefetchTtlMs?: number;
    },
  ) =>
    compileClinicGraph({
      specialists: { faq: faqAgent, booking: bookingAgent },
      agentTools: { faq: [], booking: bookingRuntimeStubs },
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
      classifyNoteTurn: async ({ patientText }) => {
        const normalized = patientText.trim().toLowerCase();
        if (
          normalized === "продовжити без коментаря"
          || normalized === "без коментаря"
          || normalized === "skip"
          || normalized === "ні"
        ) {
          return { kind: "note_skipped" as const };
        }
        return { kind: "note_provided" as const };
      },
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
    expect(names.filter((n) => n === "search_entity")).toHaveLength(2);
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
    expect(names.filter((n) => n === "search_entity")).toHaveLength(2);
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
    expect(names.filter((n) => n === "search_entity")).toHaveLength(4);
  });
});
;

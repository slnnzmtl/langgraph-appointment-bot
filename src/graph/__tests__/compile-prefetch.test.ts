import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Command, interrupt } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { clearPendingConfirmsForTests } from "../../tools/meeting-confirm.js";
import { createMeetingTools } from "../../tools/meeting-tools.js";
import { createContactTools } from "../../tools/contact-tools.js";
import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import { compileClinicGraph, prefetchBookingContext } from "../compile.js";
import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_PHONE_QUESTION_UK,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
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

describe("compileClinicGraph prefetch once", () => {
  const compileWithCallTool = (
    callTool: (name: string) => Promise<unknown>,
    extra?: {
      prefetchTtlMs?: number;
    },
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

describe("compileClinicGraph runtime-owned booking transition", () => {
  it("does not confirm creation when DETAILS has no contact and no mutation ran", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("Готово! Запис створено."));
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
      classifyNoteTurn: async ({ patientText }) => {
        const normalized = patientText.trim().toLowerCase();
        if (
          normalized === "продовжити без коментаря"
          || normalized === "без коментаря"
          || normalized === "continue with no comments"
        ) {
          return { kind: "note_skipped" as const };
        }
        return { kind: "note_provided" as const };
      },
    });

    const result = await graph.invoke(
      {
        messages: [new HumanMessage(INTENT_SKIP_LABEL)],
        pendingInteraction: {
          kind: "visit_note",
          choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
        },
        bookingDraft: {
          version: 5,
          mode: "create",
          phase: "note",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-1",
              name: "Консультація",
              source: "catalog",
            },
          },
          selectedDate: "2026-10-17",
          selectedSlot: {
            slotId: "slot-17-1130",
            label: "11:30",
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
          },
          requestedTime: null,
          note: { status: "awaiting" },
          contactId: null,
          pendingCommand: null,
          replacement: null,
        },
      } as never,
      { configurable: { thread_id: "no-contact-no-false-success" } },
    );

    const reply = String(result.messages.at(-1)?.content);
    expect(modelInvoke).toHaveBeenCalledOnce();
    expect(result.__interrupt__).toBeUndefined();
    expect(reply).toBe(BOOKING_PHONE_QUESTION_UK);
    expect(reply).not.toContain("Запис створено");
  });

  it("continues a successful contact link directly to the single meeting HITL", async () => {
    const modelInvoke = vi.fn(async () => {
      if (modelInvoke.mock.calls.length === 1) {
        return new AIMessage({
          content: "",
          tool_calls: [{
            id: "link-1",
            name: "link_telegram_to_contact",
            args: { contactId: "c-phone" },
            type: "tool_call",
          }],
        });
      }
      return new AIMessage("Підтвердіть, будь ласка, запис.");
    });
    const crmCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const [linkContact] = createContactTools({
      callTool: async (name, args) => {
        crmCalls.push({ name, args: args ?? {} });
        return `Successfully updated Contact record with ID: ${String(args?.entityId ?? "")}`;
      },
    }).filter((candidate) => candidate.name === "link_telegram_to_contact");
    const availabilityInvoke = vi.fn(async () => JSON.stringify({
      date: "2026-10-19",
      slots: [{
        id: "slot-19-1130",
        label: "11:30",
        dateStart: "2026-10-19T11:30:00",
        dateEnd: "2026-10-19T12:30:00",
      }],
      stepMinutes: 30,
      query: {
        kind: "exact",
        date: "2026-10-19",
        rangeFrom: "2026-10-19",
        rangeThrough: "2026-10-19",
        coverageComplete: true,
      },
    }));
    const createInvoke = vi.fn(async (input: Record<string, unknown>) => {
      if (input.confirmationGiven === true) {
        return JSON.stringify({ id: "meeting-1" });
      }
      const decision = interrupt({ type: "confirm_booking", draft: input });
      if (
        typeof decision === "object"
        && decision != null
        && "userReply" in decision
        && typeof decision.userReply === "string"
      ) {
        return JSON.stringify({
          awaitingConfirmation: true,
          userReply: decision.userReply,
          draft: { command: { action: "create", payload: input } },
        });
      }
      return JSON.stringify({ id: "meeting-1" });
    });
    const presentAvailability = tool(availabilityInvoke, {
      name: "present_availability_slots",
      description: "revalidate a selected slot",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        durationMinutes: z.number().optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const createMeeting = tool(createInvoke, {
      name: "create_meeting",
      description: "create a meeting after confirmation",
      schema: z.object({
        name: z.string(),
        dateStart: z.string(),
        dateEnd: z.string(),
        contactId: z.string(),
        serviceId: z.string(),
        confirmMessage: z.string(),
        description: z.string().optional(),
        confirmationGiven: z.boolean().optional(),
      }),
    });
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [linkContact, presentAvailability, createMeeting] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });

    const config = { configurable: { thread_id: "link-direct-to-hitl" } };
    const result = await runWithTelegramUserId("tg-42", () => graph.invoke(
      {
        messages: [new HumanMessage("+380 63 212 3123")],
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            firstName: "Daniel",
            lastName: "Test",
            phoneNumber: "+380632123123",
            cTelegram: null,
            missingFields: [],
          }],
        },
        availabilityContext: {
          days: [{
            date: "2026-10-19",
            slots: [{
              id: "slot-19-1130",
              label: "11:30",
              dateStart: "2026-10-19T11:30:00",
              dateEnd: "2026-10-19T12:30:00",
            }],
          }],
          stepMinutes: 30,
          serviceId: "svc-neotiva",
        },
        bookingDraft: {
          version: 4,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Збільшення губ Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
          selectedDate: "2026-10-19",
          selectedSlot: {
            slotId: "slot-19-1130",
            label: "11:30",
            dateStart: "2026-10-19T11:30:00",
            dateEnd: "2026-10-19T12:30:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: null,
          pendingCommand: null,
          replacement: null,
        },
      } as never,
      config,
    ));

    expect(crmCalls).toEqual([{
      name: "update_entity",
      args: {
        entityType: "Contact",
        entityId: "c-phone",
        data: { cTelegram: "tg-42" },
      },
    }]);
    expect(availabilityInvoke).toHaveBeenCalledOnce();
    expect(createInvoke).toHaveBeenCalledOnce();
    expect(modelInvoke).toHaveBeenCalledOnce();
    expect(result.bookingDraft).toMatchObject({
      contactId: "c-phone",
      pendingCommand: { action: "create" },
    });
    expect(result.__interrupt__?.[0]?.value).toMatchObject({ type: "confirm_booking" });

    const resumed = await runWithTelegramUserId("tg-42", () => graph.invoke(
      new Command({
        resume: { userReply: "Так, підтверджую" },
        update: { messages: [new HumanMessage("Так, підтверджую")] },
      }) as never,
      config,
    ));

    expect(modelInvoke).toHaveBeenCalledOnce();
    expect(createInvoke).toHaveBeenCalledTimes(3);
    expect(createInvoke.mock.calls.at(-1)?.[0]).toMatchObject({
      contactId: "c-phone",
      confirmationGiven: true,
    });
    expect(resumed.__interrupt__).toBeUndefined();
  });

  it.each(["без коментаря", INTENT_SKIP_LABEL])(
    "routes bare day → bare hour → %s through fresh validation into meeting HITL",
    async (skipReply) => {
      const modelInvoke = vi.fn(async () => new AIMessage("Готово! Запис створено."));
      const availabilityInvoke = vi.fn(async () => JSON.stringify({
        date: "2026-10-27",
        slots: [{
          id: "slot-27-11",
          label: "11:00",
          dateStart: "2026-10-27T11:00:00",
          dateEnd: "2026-10-27T11:30:00",
        }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2026-10-27",
          rangeFrom: "2026-10-27",
          rangeThrough: "2026-10-27",
          coverageComplete: true,
        },
      }));
      const createInvoke = vi.fn(async (input: Record<string, unknown>) =>
        interrupt({ type: "confirm_booking", draft: input }));
      const presentAvailability = tool(availabilityInvoke, {
        name: "present_availability_slots",
        description: "revalidate a selected slot",
        schema: z.object({
          direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
          date: z.string().optional(),
          durationMinutes: z.number().optional(),
          forceRefresh: z.boolean().optional(),
        }),
      });
      const createMeeting = tool(createInvoke, {
        name: "create_meeting",
        description: "create a meeting after confirmation",
        schema: z.object({
          name: z.string(),
          dateStart: z.string(),
          dateEnd: z.string(),
          contactId: z.string(),
          serviceId: z.string(),
          confirmMessage: z.string(),
          description: z.string().optional(),
        }),
      });
      const { graph } = compileClinicGraph({
        agents: [bookingAgent],
        agentTools: { booking: [presentAvailability, createMeeting] },
        agentModel: {
          bindTools: () => ({ invoke: modelInvoke }),
        } as unknown as BaseChatModel,
        supervisorLlm: {
          bindRoutingTools: () => ({
            invoke: async () => ({ next: "booking" }),
          }),
        } as ILLMConnector,
        loadSupervisorPrompt: () => "STATIC",
        formatSystemMetadata: () => "META",
        messageHistoryMaxTokens: 6_000,
        classifyNoteTurn: async ({ patientText }) => {
          const normalized = patientText.trim().toLowerCase();
          if (
            normalized === "продовжити без коментаря"
            || normalized === "без коментаря"
            || normalized === "continue with no comments"
          ) {
            return { kind: "note_skipped" as const };
          }
          return { kind: "note_provided" as const };
        },
      });
      const config = {
        configurable: { thread_id: `bare-date-note-skip-${skipReply}` },
      };

      const dateResult = await graph.invoke(
        {
          messages: [new HumanMessage("27")],
          contactContext: {
            ownership: "telegram",
            contacts: [{
              id: "c-1",
              firstName: "Ada",
              lastName: "Lovelace",
              phoneNumber: "+380501112233",
              missingFields: [],
            }],
          },
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Доступні дні — оберіть дату.",
            replyButtons: ["27 жовтня", "28 жовтня"],
          },
          availabilityContext: {
            days: [
              {
                date: "2026-10-27",
                dayLabel: "27 жовтня (вівторок)",
                slots: [{
                  id: "slot-27-11",
                  label: "11:00",
                  dateStart: "2026-10-27T11:00:00",
                  dateEnd: "2026-10-27T11:30:00",
                }],
              },
              {
                date: "2026-10-28",
                dayLabel: "28 жовтня (середа)",
                slots: [{
                  id: "slot-28-11",
                  label: "11:00",
                  dateStart: "2026-10-28T11:00:00",
                  dateEnd: "2026-10-28T11:30:00",
                }],
              },
            ],
            stepMinutes: 45,
            serviceId: CONSULTATION_SERVICE_ID,
          },
          bookingDraft: {
            version: 3,
            mode: "create",
            phase: "date",
            serviceAcceptance: {
              status: "accepted",
              service: {
                id: CONSULTATION_SERVICE_ID,
                name: "Консультація",
                durationMinutes: 30,
                source: "catalog",
              },
            },
            selectedDate: null,
            selectedSlot: null,
            note: { status: "unasked" },
            contactId: "c-1",
            pendingCommand: null,
            replacement: null,
          },
        } as never,
        config,
      );
      expect(String(dateResult.messages.at(-1)?.content)).toContain("Вільні години на 27 жовтня");

      const timeResult = await graph.invoke(
        { messages: [new HumanMessage("11")] } as never,
        config,
      );
      expect(String(timeResult.messages.at(-1)?.content)).toBe(BOOKING_NOTE_QUESTION_UK);

      const result = await graph.invoke(
        { messages: [new HumanMessage(skipReply)] } as never,
        config,
      );

      expect(modelInvoke).toHaveBeenCalledTimes(2);
      expect(availabilityInvoke).toHaveBeenCalledOnce();
      expect(availabilityInvoke).toHaveBeenCalledWith(expect.objectContaining({
        direction: "exact",
        date: "2026-10-27",
        durationMinutes: 30,
        forceRefresh: true,
      }), expect.anything());
      expect(createInvoke).toHaveBeenCalledOnce();
      expect(result.__interrupt__).toHaveLength(1);
      expect(result.__interrupt__?.[0]?.value).toMatchObject({ type: "confirm_booking" });
    },
  );

  it("returns a non-affirmative HITL chat reply to the LLM without retrying the mutation", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("Звісно, давайте підберемо інший час."));
    const availabilityInvoke = vi.fn(async () => JSON.stringify({
      date: "2026-10-27",
      slots: [{
        id: "slot-27-11",
        label: "11:00",
        dateStart: "2026-10-27T11:00:00",
        dateEnd: "2026-10-27T11:30:00",
      }],
      stepMinutes: 30,
      query: {
        kind: "exact",
        date: "2026-10-27",
        rangeFrom: "2026-10-27",
        rangeThrough: "2026-10-27",
        coverageComplete: true,
      },
    }));
    const writeInvoke = vi.fn(async () => JSON.stringify({ id: "meeting-1" }));
    const createInvoke = vi.fn(async (input: Record<string, unknown>) => {
      const decision = interrupt({ type: "confirm_booking", draft: input });
      if (
        typeof decision === "object"
        && decision != null
        && "userReply" in decision
        && typeof decision.userReply === "string"
      ) {
        return JSON.stringify({
          awaitingConfirmation: true,
          userReply: decision.userReply,
          draft: {
            command: {
              action: "create",
              payload: { parentId: input.contactId, status: "Planned" },
            },
          },
        });
      }
      return writeInvoke(input);
    });
    const presentAvailability = tool(availabilityInvoke, {
      name: "present_availability_slots",
      description: "revalidate a selected slot",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        durationMinutes: z.number().optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const createMeeting = tool(createInvoke, {
      name: "create_meeting",
      description: "create a meeting after confirmation",
      schema: z.object({
        name: z.string(),
        dateStart: z.string(),
        dateEnd: z.string(),
        contactId: z.string(),
        serviceId: z.string(),
        confirmMessage: z.string(),
        description: z.string().optional(),
        confirmationGiven: z.boolean().optional(),
      }),
    });
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [presentAvailability, createMeeting] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });
    const config = {
      configurable: { thread_id: "non-affirmative-hitl-reply" },
    };

    const first = await graph.invoke(
      {
        messages: [new HumanMessage("записатися")],
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-1",
            firstName: "Ada",
            lastName: "Lovelace",
            phoneNumber: "+380501112233",
            missingFields: [],
          }],
        },
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-1",
              name: "Процедура",
              durationMinutes: 30,
              source: "catalog",
            },
          },
          selectedDate: "2026-10-27",
          selectedSlot: {
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
            label: "11:00",
          },
          requestedTime: null,
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: null,
          replacement: null,
        },
      } as never,
      config,
    );
    expect(first.__interrupt__).toHaveLength(1);

    const reply = "А можна інший час?";
    const second = await graph.invoke(
      new Command({
        resume: { userReply: reply },
        update: { messages: [new HumanMessage(reply)] },
      }) as never,
      config,
    );

    expect(writeInvoke).not.toHaveBeenCalled();
    expect(modelInvoke).toHaveBeenCalledOnce();
    expect(second.__interrupt__).toBeUndefined();
    expect(second.bookingDraft?.pendingCommand).toBeNull();
    expect(second.bookingDraft?.selectedSlot).toBeNull();

    const createCallsAfterReply = createInvoke.mock.calls.length;
    const third = await graph.invoke(
      { messages: [new HumanMessage("Дякую")] } as never,
      config,
    );

    expect(createInvoke).toHaveBeenCalledTimes(createCallsAfterReply);
    expect(writeInvoke).not.toHaveBeenCalled();
    expect(third.__interrupt__).toBeUndefined();
  });

  it("requires a fresh card when a later model call reuses cleared confirmation args", async () => {
    const availabilityInvoke = vi.fn(async () => JSON.stringify({
      date: "2026-10-27",
      slots: [{
        id: "slot-27-11",
        label: "11:00",
        dateStart: "2026-10-27T11:00:00",
        dateEnd: "2026-10-27T11:30:00",
      }],
      stepMinutes: 30,
      query: {
        kind: "exact",
        date: "2026-10-27",
        rangeFrom: "2026-10-27",
        rangeThrough: "2026-10-27",
        coverageComplete: true,
      },
    }));
    const writeInvoke = vi.fn(async () => ({ success: true, id: "meeting-1" }));
    const callTool = vi.fn(async (name: string, _args: Record<string, unknown>) => {
      if (name === "get_entity") {
        return {
          id: "c-1",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
          cTelegram: "tg-1",
        };
      }
      if (name === "search_entity") {
        return { list: [] };
      }
      if (name === "create_meeting") {
        return writeInvoke();
      }
      throw new Error(`Unexpected MCP tool: ${name}`);
    });
    const createMeeting = createMeetingTools({
      callTool,
      assignedUserId: "assigned-1",
    }).find((candidate) => candidate.name === "create_meeting")!;
    const presentAvailability = tool(availabilityInvoke, {
      name: "present_availability_slots",
      description: "revalidate a selected slot",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        durationMinutes: z.number().optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const staleArgs = {
      name: "Процедура - Ada Lovelace",
      dateStart: "2026-10-27T11:00:00",
      dateEnd: "2026-10-27T11:30:00",
      contactId: "c-1",
      serviceId: "svc-1",
      confirmMessage: "Підтвердити запис?",
      confirmationGiven: true,
    };
    const modelInvoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage("Звісно, підберемо інший час."))
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{
          id: "stale-create",
          name: "create_meeting",
          args: staleArgs,
          type: "tool_call",
        }],
      }));
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [presentAvailability, createMeeting] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });
    const config = { configurable: { thread_id: "cleared-chat-confirmation" } };
    const invoke = (input: unknown) =>
      runWithTelegramUserId("tg-1", () => graph.invoke(input as never, config));

    const first = await invoke({
      messages: [new HumanMessage("записатися")],
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-1",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
          missingFields: [],
        }],
      },
      bookingDraft: {
        version: 1,
        mode: "create",
        phase: "details",
        serviceAcceptance: {
          status: "accepted",
          service: {
            id: "svc-1",
            name: "Процедура",
            durationMinutes: 30,
            source: "catalog",
          },
        },
        selectedDate: "2026-10-27",
        selectedSlot: {
          dateStart: "2026-10-27T11:00:00",
          dateEnd: "2026-10-27T11:30:00",
          label: "11:00",
        },
        requestedTime: null,
        note: { status: "skipped" },
        contactId: "c-1",
        pendingCommand: null,
        replacement: null,
      },
    });
    expect(first.__interrupt__).toHaveLength(1);

    const reply = "Яка адреса?";
    const second = await invoke(new Command({
      resume: { userReply: reply },
      update: { messages: [new HumanMessage(reply)] },
    }));
    expect(second.__interrupt__).toBeUndefined();
    expect(second.bookingDraft?.pendingCommand).toBeNull();

    const third = await invoke({ messages: [new HumanMessage("Так")] });

    expect(writeInvoke).not.toHaveBeenCalled();
    expect(third.__interrupt__).toHaveLength(1);
    expect(third.__interrupt__?.[0]?.value).toMatchObject({ type: "confirm_booking" });
  });

  it("ends a reschedule on typed no without another LLM or availability offer", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("Модель не повинна викликатися."));
    const updateInvoke = vi.fn(async () => ({ success: true, id: "m-1" }));
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_entity" && args.entityType === "Meeting") {
        return {
          id: "m-1",
          name: "Консультація - Ada Lovelace",
          parentType: "Contact",
          parentId: "c-1",
          dateStart: "2026-10-20 12:00:00",
          dateEnd: "2026-10-20 12:30:00",
        };
      }
      if (name === "get_entity" && args.entityType === "Contact") {
        return { id: "c-1", cTelegram: "tg-reschedule" };
      }
      if (name === "update_meeting") {
        return updateInvoke();
      }
      throw new Error(`Unexpected MCP tool: ${name}`);
    });
    const rescheduleMeeting = createMeetingTools({
      callTool,
      assignedUserId: "assigned-1",
    }).find((candidate) => candidate.name === "reschedule_meeting");
    if (!rescheduleMeeting) {
      throw new Error("reschedule_meeting tool missing");
    }
    const availability = {
      date: "2026-10-27",
      slots: [{
        id: "slot-27-11",
        label: "11:00",
        dateStart: "2026-10-27T11:00:00",
        dateEnd: "2026-10-27T11:30:00",
      }],
      stepMinutes: 30,
      excludeMeetingIds: ["m-1"],
      query: {
        kind: "exact",
        date: "2026-10-27",
        rangeFrom: "2026-10-27",
        rangeThrough: "2026-10-27",
        coverageComplete: true,
      },
    };
    const presentAvailability = tool(async () => JSON.stringify(availability), {
      name: "present_availability_slots",
      description: "revalidate a selected slot",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        excludeMeetingIds: z.array(z.string()).optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [presentAvailability, rescheduleMeeting] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ next: "booking" }),
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });
    const config = { configurable: { thread_id: "typed-reschedule-no" } };
    const invoke = (input: unknown) =>
      runWithTelegramUserId("tg-reschedule", () => graph.invoke(input as never, config));

    const first = await invoke({
      messages: [new HumanMessage("Підтверджую")],
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-1",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
          missingFields: [],
        }],
      },
      availabilityContext: {
        days: [{ date: "2026-10-27", slots: availability.slots }],
        stepMinutes: 30,
        excludeMeetingIds: ["m-1"],
      },
      agentMessages: [new ToolMessage({
        content: JSON.stringify(availability),
        name: "present_availability_slots",
        tool_call_id: "availability-1",
      })],
      bookingContext: {
        meetings: [{
          id: "m-1",
          name: "Консультація - Ada Lovelace",
          dateStart: "2026-10-20 12:00:00",
          dateEnd: "2026-10-20 12:30:00",
        }],
        dateFrom: "2026-10-01",
        latestHeld: null,
      },
      bookingDraft: {
        version: 1,
        mode: "reschedule",
        phase: "ready",
        serviceAcceptance: {
          status: "accepted",
          service: {
            id: "svc-1",
            name: "Консультація",
            durationMinutes: 30,
            source: "crm",
          },
        },
        selectedDate: "2026-10-27",
        selectedSlot: availability.slots[0],
        requestedTime: null,
        note: { status: "unasked" },
        contactId: "c-1",
        pendingCommand: null,
        rescheduleTarget: {
          id: "m-1",
          name: "Консультація - Ada Lovelace",
          dateStart: "2026-10-20 12:00:00",
          dateEnd: "2026-10-20 12:30:00",
        },
        replacement: null,
      },
    });
    expect(first.__interrupt__).toHaveLength(1);

    const second = await invoke(new Command({ resume: { userReply: "ні" } }));

    expect(modelInvoke).not.toHaveBeenCalled();
    expect(updateInvoke).not.toHaveBeenCalled();
    expect(second.__interrupt__).toBeUndefined();
    expect(second.messages.at(-1)?.content).toBe("Запис не було перенесено.");
    expect(second.bookingDraft).toBeNull();

    const third = await invoke({ messages: [new HumanMessage("Дякую")] });
    expect(updateInvoke).not.toHaveBeenCalled();
    expect(third.__interrupt__).toBeUndefined();
  });
});

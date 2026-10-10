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
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_PHONE_QUESTION_UK,
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
import type { ResolveServiceChange } from "../booking-note-orchestrator.js";

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
  it("opens service_candidate replyButtons for explicit service change from note free-text", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("LLM must not author catalog chips."));
    const supervisorInvoke = vi.fn(async () => ({ next: "faq" }));
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: supervisorInvoke,
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
      // Classifier/eval treat «запиши на ботокс» as an explicit service change.
      classifyNoteTurn: async () => ({
        kind: "service_change_requested" as const,
        query: "ботокс",
      }),
      resolveServiceChange: async () => ({
        type: "service_candidates_opened" as const,
        utterance: "запиши на ботокс",
        query: "ботокс",
        choices: [
          {
            id: "g0",
            label: "Botox/Disport",
            serviceIds: ["svc-botox-face", "svc-botox-neck"],
          },
          { id: "svc-nabota", label: "Nabota", serviceIds: ["svc-nabota"] },
          {
            id: "g2",
            label: SERVICE_CANDIDATE_OTHER_LABEL_UK,
            serviceIds: ["svc-correction", "svc-meso"],
          },
        ],
      }),
    });

    const result = await graph.invoke(
      {
        messages: [new HumanMessage("запиши на ботокс")],
        pendingInteraction: {
          kind: "visit_note",
          choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
        },
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: BOOKING_NOTE_QUESTION_UK,
          replyButtons: [INTENT_SKIP_LABEL],
        },
        bookingDraft: {
          version: 5,
          mode: "create",
          phase: "note",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: CONSULTATION_SERVICE_ID,
              name: "Консультація",
              source: "catalog",
            },
          },
          selectedDate: "2026-10-19",
          selectedSlot: {
            dateStart: "2026-10-19T11:30:00",
            dateEnd: "2026-10-19T12:00:00",
            label: "11:30",
          },
          requestedTime: null,
          note: { status: "awaiting" },
          contactId: "c-1",
          pendingCommand: null,
          replacement: null,
        },
      } as never,
      { configurable: { thread_id: "note-free-text-service-candidate" } },
    );

    expect(supervisorInvoke).not.toHaveBeenCalled();
    expect(modelInvoke).not.toHaveBeenCalled();
    expect(result.pendingInteraction?.kind).toBe("service_candidate");
    expect(result.lastHandoff?.replyButtons).toEqual([
      "Botox/Disport",
      "Nabota",
      SERVICE_CANDIDATE_OTHER_LABEL_UK,
    ]);
    const reply = String(result.lastHandoff?.replyText ?? "");
    expect(reply).toContain("• Botox/Disport");
    expect(reply).toContain("• Nabota");
    expect(reply).toContain(`• ${SERVICE_CANDIDATE_OTHER_LABEL_UK}`);
    expect(reply).not.toContain("Обрати іншу процедуру");
    expect(reply).not.toContain("(Консультація)");
    expect(reply).not.toContain(SERVICE_OR_NOTE_KEEP_LABEL_UK);

    const outbound = interpretInvokeResult(result);
    const keyboard = (outbound.reply_markup as ReplyKeyboardMarkup).keyboard;
    const labels = keyboard.flat().map((button) => button.text);
    expect(labels).toEqual([
      "Botox/Disport",
      "Nabota",
      SERVICE_CANDIDATE_OTHER_LABEL_UK,
      MAIN_MENU_LABEL,
    ]);
    expect(labels).not.toContain("Обрати іншу процедуру");
    expect(labels).not.toContain(SERVICE_OR_NOTE_KEEP_LABEL_UK);
    expect(labels).not.toContain(SERVICE_OR_NOTE_SWITCH_LABEL_UK);
  });

  it("service change → narrowing → Neotiva forces fresh DATE then note then HITL", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("Готово! Запис створено."));
    const availabilityInvoke = vi.fn(async (input: Record<string, unknown>) => {
      if (input.direction === "nearest") {
        return JSON.stringify({
          days: [
            {
              date: "2026-10-20",
              dayLabel: "20 жовтня (вівторок)",
              slots: [{
                id: "slot-20-12",
                label: "12:00",
                dateStart: "2026-10-20T12:00:00",
                dateEnd: "2026-10-20T13:00:00",
              }],
            },
            {
              date: "2026-10-22",
              dayLabel: "22 жовтня (четвер)",
              slots: [{
                id: "slot-22-11",
                label: "11:00",
                dateStart: "2026-10-22T11:00:00",
                dateEnd: "2026-10-22T12:00:00",
              }],
            },
          ],
          stepMinutes: 60,
          query: {
            kind: "nearest",
            rangeFrom: "2026-10-08",
            rangeThrough: "2026-10-22",
            coverageComplete: true,
          },
        });
      }
      return JSON.stringify({
        date: "2026-10-20",
        slots: [{
          id: "slot-20-12",
          label: "12:00",
          dateStart: "2026-10-20T12:00:00",
          dateEnd: "2026-10-20T13:00:00",
        }],
        stepMinutes: 60,
        query: {
          kind: "exact",
          date: "2026-10-20",
          rangeFrom: "2026-10-20",
          rangeThrough: "2026-10-20",
          coverageComplete: true,
        },
      });
    });
    const createInvoke = vi.fn(async (input: Record<string, unknown>) =>
      interrupt({ type: "confirm_booking", draft: input }));
    const presentAvailability = tool(availabilityInvoke, {
      name: "present_availability_slots",
      description: "availability",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        durationMinutes: z.number().optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const createMeeting = tool(createInvoke, {
      name: "create_meeting",
      description: "create",
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
    const resolveServiceChange = vi.fn<ResolveServiceChange>(async (effect) => {
      // Group tap leaves three brand ids; brand tap is a singleton CRM id.
      if (effect.remainingIds != null && effect.remainingIds.length > 1) {
        return {
          type: "service_candidates_opened",
          utterance: effect.utterance,
          choices: [
            { id: "svc-neotiva", label: "Neotiva", serviceIds: ["svc-neotiva"] },
            { id: "svc-juvederm", label: "Juvederm", serviceIds: ["svc-juvederm"] },
            { id: "svc-stylage", label: "Stylage", serviceIds: ["svc-stylage"] },
          ],
        };
      }
      if (
        effect.query === "svc-neotiva"
        || effect.utterance === "Neotiva"
        || effect.remainingIds?.[0] === "svc-neotiva"
      ) {
        return {
          type: "service_changed",
          service: {
            id: "svc-neotiva",
            name: "Збільшення губ Neotiva",
            durationMinutes: 60,
            source: "catalog",
          },
          accepted: true,
        };
      }
      return {
        type: "service_candidates_opened",
        utterance: effect.utterance,
        query: effect.query,
        choices: [
          {
            id: "g0",
            label: "Збільшення губ",
            serviceIds: ["svc-neotiva", "svc-juvederm", "svc-stylage"],
          },
          {
            id: "g1",
            label: "Корекція та видалення",
            serviceIds: ["svc-correction"],
          },
        ],
      };
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
        if (normalized.includes("збільшення губ") || normalized.includes("neotiva")) {
          return {
            kind: "service_change_requested" as const,
            query: "збільшення губ",
          };
        }
        return { kind: "unresolved" as const };
      },
      resolveServiceChange,
    });
    const config = { configurable: { thread_id: "service-change-neotiva-hitl" } };
    const contactContext = {
      ownership: "telegram" as const,
      contacts: [{
        id: "c-1",
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501112233",
        missingFields: [] as string[],
      }],
    };
    const consultationDraft = {
      version: 5,
      mode: "create" as const,
      phase: "note" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: {
          id: CONSULTATION_SERVICE_ID,
          name: "Консультація",
          durationMinutes: 30,
          source: "catalog" as const,
        },
      },
      selectedDate: "2026-10-20",
      selectedSlot: {
        dateStart: "2026-10-20T12:00:00",
        dateEnd: "2026-10-20T12:30:00",
        label: "12:00",
      },
      requestedTime: null,
      note: { status: "awaiting" as const },
      contactId: "c-1",
      pendingCommand: null,
      replacement: null,
    };

    const groups = await graph.invoke(
      {
        messages: [new HumanMessage("запиши на збільшення губ")],
        contactContext,
        pendingInteraction: {
          kind: "visit_note",
          choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
        },
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: BOOKING_NOTE_QUESTION_UK,
          replyButtons: [INTENT_SKIP_LABEL],
        },
        bookingDraft: consultationDraft,
      } as never,
      config,
    );
    const groupsReply = String(groups.lastHandoff?.replyText ?? "");
    expect(groupsReply).toContain(SERVICE_CHANGE_ACK_UK);
    expect(groupsReply).toContain("• Збільшення губ");
    expect(groups.pendingInteraction?.kind).toBe("service_candidate");
    expect(createInvoke).not.toHaveBeenCalled();
    expect(groups.__interrupt__).toBeUndefined();

    const brands = await graph.invoke(
      { messages: [new HumanMessage("Збільшення губ")] } as never,
      config,
    );
    expect(String(brands.lastHandoff?.replyText ?? "")).toContain("• Neotiva");
    expect(brands.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["Neotiva", "Juvederm", "Stylage"]),
    );
    expect(createInvoke).not.toHaveBeenCalled();

    const afterService = await graph.invoke(
      { messages: [new HumanMessage("Neotiva")] } as never,
      config,
    );
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const dateReply = String(afterService.lastHandoff?.replyText ?? "");
    expect(dateReply.startsWith(notice)).toBe(true);
    expect(dateReply).toContain("20 жовтня");
    expect(dateReply).not.toContain("Запис створено");
    expect(afterService.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-neotiva");
    expect(afterService.bookingDraft?.selectedSlot).toBeNull();
    expect(afterService.bookingDraft?.phase).toBe("date");
    expect(availabilityInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "nearest",
        forceRefresh: true,
        durationMinutes: 60,
      }),
      expect.anything(),
    );
    expect(createInvoke).not.toHaveBeenCalled();
    expect(afterService.__interrupt__).toBeUndefined();

    const timeResult = await graph.invoke(
      { messages: [new HumanMessage("20 жовтня")] } as never,
      config,
    );
    expect(String(timeResult.messages.at(-1)?.content)).toContain("Вільні години");
    expect(createInvoke).not.toHaveBeenCalled();

    const noteResult = await graph.invoke(
      { messages: [new HumanMessage("12:00")] } as never,
      config,
    );
    const notePrompt = String(noteResult.messages.at(-1)?.content);
    expect(notePrompt).toContain(BOOKING_NOTE_QUESTION_UK);
    expect(noteResult.bookingDraft?.note.status).toBe("awaiting");
    expect(createInvoke).not.toHaveBeenCalled();

    const hitl = await graph.invoke(
      { messages: [new HumanMessage(INTENT_SKIP_LABEL)] } as never,
      config,
    );
    expect(createInvoke).toHaveBeenCalled();
    expect(hitl.__interrupt__).toHaveLength(1);
    expect(hitl.__interrupt__?.[0]?.value).toMatchObject({ type: "confirm_booking" });
    expect(createInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "svc-neotiva",
        dateStart: "2026-10-20T12:00:00",
        dateEnd: "2026-10-20T13:00:00",
      }),
      expect.anything(),
    );
  });

  it("TIME free-text consultation switch searches nearest and shows a DATE card", async () => {
    const modelInvoke = vi.fn(async () => new AIMessage("Готово! Запис створено."));
    const availabilityInvoke = vi.fn(async () =>
      JSON.stringify({
        days: [
          {
            date: "2026-10-19",
            dayLabel: "19 жовтня (понеділок)",
            slots: [
              {
                id: "slot-19-11",
                label: "11:30",
                dateStart: "2026-10-19T11:30:00",
                dateEnd: "2026-10-19T12:00:00",
              },
            ],
          },
          {
            date: "2026-10-20",
            dayLabel: "20 жовтня (вівторок)",
            slots: [
              {
                id: "slot-20-12",
                label: "12:00",
                dateStart: "2026-10-20T12:00:00",
                dateEnd: "2026-10-20T12:30:00",
              },
            ],
          },
        ],
        stepMinutes: 30,
        query: {
          kind: "nearest",
          rangeFrom: "2026-10-08",
          rangeThrough: "2026-10-20",
          coverageComplete: true,
        },
      }),
    );
    const presentAvailability = tool(availabilityInvoke, {
      name: "present_availability_slots",
      description: "availability",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
        date: z.string().optional(),
        durationMinutes: z.number().optional(),
        forceRefresh: z.boolean().optional(),
      }),
    });
    const resolveServiceChange = vi.fn<ResolveServiceChange>(async () => ({
      type: "service_changed",
      service: {
        id: CONSULTATION_SERVICE_ID,
        name: "Консультація",
        durationMinutes: 30,
        source: "catalog",
      },
      accepted: true,
    }));
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [presentAvailability] },
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
      classifyNoteTurn: async ({ patientText, draftPhase }) => {
        expect(draftPhase).toBe("time");
        if (patientText.toLowerCase().includes("консультац")) {
          return {
            kind: "service_change_requested" as const,
            query: "консультацію",
          };
        }
        return { kind: "unresolved" as const };
      },
      resolveServiceChange,
    });
    const config = { configurable: { thread_id: "time-consult-switch" } };
    const botoxTimeDraft = {
      version: 5,
      mode: "create" as const,
      phase: "time" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: {
          id: "svc-botox-1zone",
          name: "Ботулінотерапія Botox, Disport 1 зона",
          durationMinutes: 30,
          source: "catalog" as const,
        },
      },
      selectedDate: "2026-10-19",
      selectedSlot: null,
      requestedTime: null,
      note: { status: "unasked" as const },
      contactId: "c-1",
      pendingCommand: null,
      replacement: null,
    };
    const timeAvailability = {
      serviceId: "svc-botox-1zone",
      days: [
        {
          date: "2026-10-19",
          dayLabel: "19 жовтня (понеділок)",
          slots: [
            {
              id: "slot-19-11",
              label: "11:30",
              dateStart: "2026-10-19T11:30:00",
              dateEnd: "2026-10-19T12:00:00",
            },
            {
              id: "slot-19-12",
              label: "12:30",
              dateStart: "2026-10-19T12:30:00",
              dateEnd: "2026-10-19T13:00:00",
            },
          ],
        },
      ],
      stepMinutes: 30,
      query: {
        kind: "exact" as const,
        date: "2026-10-19",
        rangeFrom: "2026-10-19",
        rangeThrough: "2026-10-19",
        coverageComplete: true,
      },
    };

    const switched = await graph.invoke(
      {
        messages: [new HumanMessage("давай все ж на консультацію")],
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-1",
            firstName: "Ada",
            lastName: "Lovelace",
            phoneNumber: "+380501112233",
            missingFields: [] as string[],
          }],
        },
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Вільні години на 19 жовтня (понеділок)",
          replyButtons: ["11:30", "12:30", "13:30"],
        },
        bookingDraft: botoxTimeDraft,
        availabilityContext: timeAvailability,
      } as never,
      config,
    );

    const notice = serviceChangedNoticeUk("Консультація");
    const reply = String(switched.lastHandoff?.replyText ?? "");
    expect(reply.startsWith(notice)).toBe(true);
    expect(reply).toContain("19 жовтня");
    expect(reply).toContain("20 жовтня");
    expect(reply).not.toContain("Вільні години на 19 жовтня");
    expect(reply).not.toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(switched.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["19 жовтня", "20 жовтня"]),
    );
    expect(switched.bookingDraft?.serviceAcceptance?.service.id).toBe(
      CONSULTATION_SERVICE_ID,
    );
    expect(switched.bookingDraft?.selectedDate).toBeNull();
    expect(switched.bookingDraft?.phase).toBe("date");
    expect(availabilityInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "nearest",
        forceRefresh: true,
        durationMinutes: 30,
      }),
      expect.anything(),
    );
  });

  it("FAQ catalog chip after service_unresolved stays in FAQ, not Booking", async () => {
    const agentInvoke = vi.fn(async () => new AIMessage(
      "Ботулінотерапія: Botox/Disport або Nabota. Який варіант вам підходить?",
    ));
    const supervisorInvoke = vi.fn(async () => ({ next: "booking" }));
    const { graph } = compileClinicGraph({
      agents: [bookingAgent, faqAgent],
      agentTools: { booking: [], faq: [] },
      agentModel: {
        bindTools: () => ({ invoke: agentInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke: supervisorInvoke }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });

    const result = await graph.invoke(
      {
        messages: [new HumanMessage("Ботулінотерапія")],
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          replyText: "Оберіть послугу зі списку",
          replyButtons: ["Ботулінотерапія", "Консультація", RETURN_TO_BOOKING_LABEL_UK],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "процедури",
          choices: [
            { id: "svc-b", label: "Ботулінотерапія", serviceIds: ["svc-b"] },
            { id: "svc-c", label: "Консультація", serviceIds: ["svc-c"] },
          ],
        },
        bookingDraft: {
          version: 5,
          mode: "create",
          phase: "note",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-botox",
              name: "Ботулінотерапія Botox, Disport 1 зона",
              durationMinutes: 30,
              source: "catalog",
            },
          },
          selectedDate: "2026-10-19",
          selectedSlot: {
            dateStart: "2026-10-19T11:30:00",
            dateEnd: "2026-10-19T12:00:00",
            label: "11:30",
          },
          requestedTime: null,
          note: { status: "awaiting" },
          contactId: "c-1",
          pendingCommand: null,
          replacement: null,
        },
      } as never,
      { configurable: { thread_id: "faq-after-unresolved" } },
    );

    // Sticky FAQ must win over the preserved booking interaction; supervisor
    // would otherwise send the patient to Booking.
    expect(supervisorInvoke).not.toHaveBeenCalled();
    expect(agentInvoke).toHaveBeenCalled();
    expect(result.lastHandoff?.agentId).toBe("faq");
    expect(result.pendingInteraction?.kind).toBe("service_candidate");
    expect(result.pendingInteraction?.owner).toBe("faq");
    expect(String(result.lastHandoff?.replyText ?? "")).toContain("Ботулінотерапія");
    expect(result.bookingDraft?.phase).toBe("note");
  });

  it("TIME free-text unresolved keeps the TIME card, not the note question", async () => {
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
      classifyNoteTurn: async () => ({ kind: "unresolved" as const }),
      resolveServiceChange: async () => ({ type: "service_unresolved" }),
    });
    const day = {
      date: "2026-10-19",
      dayLabel: "19 жовтня (понеділок)",
      slots: [
        {
          id: "slot-19-11",
          label: "11:30",
          dateStart: "2026-10-19T11:30:00",
          dateEnd: "2026-10-19T12:00:00",
        },
        {
          id: "slot-19-12",
          label: "12:30",
          dateStart: "2026-10-19T12:30:00",
          dateEnd: "2026-10-19T13:00:00",
        },
        {
          id: "slot-19-13",
          label: "13:30",
          dateStart: "2026-10-19T13:30:00",
          dateEnd: "2026-10-19T14:00:00",
        },
      ],
    };
    const result = await graph.invoke(
      {
        messages: [new HumanMessage("хм")],
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Вільні години на 19 жовтня (понеділок)",
          replyButtons: ["11:30", "12:30", "13:30"],
        },
        bookingDraft: {
          version: 5,
          mode: "create",
          phase: "time",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-botox-1zone",
              name: "Ботулінотерапія Botox, Disport 1 зона",
              durationMinutes: 30,
              source: "catalog",
            },
          },
          selectedDate: "2026-10-19",
          selectedSlot: null,
          requestedTime: null,
          note: { status: "unasked" },
          contactId: "c-1",
          pendingCommand: null,
          replacement: null,
        },
        availabilityContext: {
          serviceId: "svc-botox-1zone",
          days: [day],
          stepMinutes: 30,
        },
      } as never,
      { configurable: { thread_id: "time-unresolved-keeps-card" } },
    );

    const reply = String(result.lastHandoff?.replyText ?? "");
    expect(reply).toContain("Вільні години");
    expect(reply).toContain("11:30");
    expect(reply).not.toContain(BOOKING_NOTE_QUESTION_UK);
    expect(reply).not.toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(result.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["11:30", "12:30", "13:30"]),
    );
    expect(result.pendingInteraction?.kind).toBe("time_select");
    expect(result.bookingDraft?.selectedDate).toBe("2026-10-19");
  });

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

    // Adapter maps NL affirm to { confirmed: true } when mutation_confirm is open.
    const resumed = await runWithTelegramUserId("tg-42", () => graph.invoke(
      new Command({
        resume: { confirmed: true },
        update: {
          messages: [new HumanMessage("Так, підтверджую")],
          pendingInteraction: null,
        },
      }) as never,
      config,
    ));

    expect(modelInvoke).toHaveBeenCalledOnce();
    expect(createInvoke).toHaveBeenCalledTimes(2);
    expect(createInvoke.mock.calls.at(-1)?.[0]).toMatchObject({
      contactId: "c-phone",
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
      const notePrompt = String(timeResult.messages.at(-1)?.content);
      expect(notePrompt).toBe(BOOKING_NOTE_QUESTION_UK);
      expect(notePrompt).not.toContain(`• ${INTENT_SKIP_LABEL}`);
      expect(timeResult.lastHandoff?.replyButtons).toEqual([INTENT_SKIP_LABEL]);

      const result = await graph.invoke(
        { messages: [new HumanMessage(skipReply)] } as never,
        config,
      );

      expect(modelInvoke).toHaveBeenCalledOnce();
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

    // After chat-other invalidates the slot, a later "Так" must not reuse the
    // cleared confirmation path. Runtime recovers with a fresh TIME card.
    expect(writeInvoke).not.toHaveBeenCalled();
    expect(third.__interrupt__).toBeUndefined();
    expect(third.pendingInteraction?.kind).toBe("time_select");
    expect(String(third.lastHandoff?.replyText ?? "")).toContain("Вільні години");
    expect(third.lastHandoff?.replyButtons).toEqual(expect.arrayContaining(["11:00"]));
    expect(modelInvoke).toHaveBeenCalledOnce();
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

    // Facade must not clear pendingCommand before the tools node re-runs;
    // otherwise the reschedule guard synthesizes "Reschedule state required".
    const hitl = resumeConfirmBookingHitl({
      text: "❌",
      bookingDraft: first.bookingDraft,
      pendingInteraction: first.pendingInteraction,
    });
    expect(hitl.resume).toEqual({ confirmed: false });
    expect(hitl.update.bookingDraft).toBeUndefined();
    expect(hitl.update.pendingInteraction).toBeUndefined();

    const second = await invoke(new Command({
      resume: hitl.resume,
      update: hitl.update,
    }));

    expect(modelInvoke).not.toHaveBeenCalled();
    expect(updateInvoke).not.toHaveBeenCalled();
    expect(second.__interrupt__).toBeUndefined();
    expect(second.messages.at(-1)?.content).toBe("Запис не було перенесено.");
    expect(second.bookingDraft).toBeNull();
    // Declined path closed the session; blocked "Reschedule state required" would
    // have routed to the booking LLM and re-offered times.
    expect(String(second.lastHandoff?.replyText ?? "")).not.toContain("Вільні години");

    const third = await invoke({ messages: [new HumanMessage("Дякую")] });
    expect(updateInvoke).not.toHaveBeenCalled();
    expect(third.__interrupt__).toBeUndefined();
  });

  it("returns to the supervisor main menu when Головне меню is tapped on a reschedule confirm", async () => {
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
        return { id: "c-1", cTelegram: "tg-reschedule-leave" };
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
    // First call routes into the reschedule HITL; the leave handoff calls the
    // supervisor again and must FINISH with the default menu.
    const supervisorInvoke = vi.fn(async () => {
      if (supervisorInvoke.mock.calls.length === 1) {
        return { next: "booking" };
      }
      return {
        next: "FINISH",
        reply: "Привіт! Чим можу допомогти?",
        menu: "default",
      };
    });
    const { graph } = compileClinicGraph({
      agents: [bookingAgent],
      agentTools: { booking: [presentAvailability, rescheduleMeeting] },
      agentModel: {
        bindTools: () => ({ invoke: modelInvoke }),
      } as unknown as BaseChatModel,
      supervisorLlm: {
        bindRoutingTools: () => ({
          invoke: supervisorInvoke,
        }),
      } as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      formatSystemMetadata: () => "META",
      messageHistoryMaxTokens: 6_000,
    });
    const config = { configurable: { thread_id: "reschedule-confirm-main-menu" } };
    const invoke = (input: unknown) =>
      runWithTelegramUserId("tg-reschedule-leave", () => graph.invoke(input as never, config));

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

    const hitl = resumeConfirmBookingHitl({
      text: "Головне меню",
      bookingDraft: first.bookingDraft,
      pendingInteraction: first.pendingInteraction,
    });
    expect(hitl.resume).toEqual({ left: true });

    const second = await invoke(new Command({
      resume: hitl.resume,
      update: hitl.update,
    }));

    expect(updateInvoke).not.toHaveBeenCalled();
    expect(modelInvoke).not.toHaveBeenCalled();
    expect(second.__interrupt__).toBeUndefined();
    expect(second.bookingDraft).toBeNull();
    expect(second.pendingInteraction).toBeNull();
    expect(second.lastHandoff?.agentId).toBe("FINISH");
    expect(second.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["Мій запис", "Послуги", "Адреса"]),
    );
    expect(String(second.lastHandoff?.replyText ?? "")).not.toContain("Вільні години");
    expect(String(second.messages.at(-1)?.content ?? "")).not.toContain("Вільні години");
    expect(supervisorInvoke).toHaveBeenCalled();
  });
});

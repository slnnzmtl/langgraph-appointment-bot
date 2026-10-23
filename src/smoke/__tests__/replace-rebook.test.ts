import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig, MemorySaver } from "@langchain/langgraph";
import { expect, it, vi } from "vitest";

import { buildClinicAgentTools } from "../../composition/clinic-agent-tools.js";
import type { ClinicAdapters } from "../../composition/clinic-adapters.js";
import type { ClinicRuntime } from "../../composition/clinic-runtime.js";
import type { AppConfig } from "../../config.js";
import { compileClinicGraph } from "../../graph/compile.js";
import { interpretBookingTurnDeterministic } from "../../graph/booking-domain/interpret.js";
import type { ClinicSpecialists, ILLMConnector } from "../../graph/types.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { bookProcedureScenario, replaceProcedureScenario, replaceRebookScenario } from "../scenarios/booking-write.js";

// Real scenario, graph, adapter, tools and interrupts; only CRM and LLM are fixtures.
it.each([
  ...(["success", "rejected", "lost-duration", "stored-duration", "stored-service"] as const)
    .map((mode) => ({ scenario: replaceRebookScenario, mode })),
  { scenario: bookProcedureScenario, mode: "success" as const },
  { scenario: replaceProcedureScenario, mode: "success" as const },
])(
  "$scenario.name preserves independent service/interval evidence: $mode",
  async ({ scenario, mode }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T19:28:00Z"));
    const services = [
      { id: CONSULTATION_SERVICE_ID, name: "Консультація", duration: 30 },
      { id: "procedure-60", name: "Колагеностимуляція Полімолочна кислота", duration: 60 },
    ];
    const procedure = services[1]!;
    let contact: Record<string, unknown> | null = null;
    const meetings: Record<string, unknown>[] = [];
    const writes: Record<string, unknown>[] = [];
    const adapters: ClinicAdapters = {
      shutdown: async () => {},
      callTool: async (name, args) => {
        if (name === "search_contacts") {
          return { contacts: contact && (args.cTelegram === contact.cTelegram || args.phoneNumber === contact.phoneNumber) ? [{ ...contact }] : [] };
        }
        if (name === "create_contact") {
          contact = { id: "contact-offline", ...args };
          return { ...contact };
        }
        if (name === "update_entity" && args.entityType === "Contact") {
          Object.assign(contact!, asJsonRecord(args.data));
          return { ...contact };
        }
        if (name === "get_entity") {
          return args.entityType === "Contact"
            ? { ...contact }
            : { ...meetings.find((meeting) => meeting.id === args.entityId) };
        }
        if (name === "get_working_time") {
          return { success: true, calendars: [{
            name: "Main", timeRanges: [["11:00", "15:00"]],
            weekdays: { "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": true },
            weekdayTimeRanges: {},
          }], ranges: [] };
        }
        if (name === "search_entity") {
          if (args.entityType === "cService") {
            // Independent oracle reads still return 60; simulate loss at bot catalog ingress only.
            let inGraph = false;
            try { inGraph = getConfig()?.configurable?.thread_id != null; } catch { /* direct oracle read */ }
            const list = mode === "lost-duration" && inGraph
              ? services.map(({ id, name: serviceName }) => ({ id, name: serviceName }))
              : services;
            return { list, total: list.length };
          }
          if (args.entityType === "CReservedTime") return { list: [], total: 0 };
          if (args.entityType === "Meeting") {
            const filters = asJsonRecord(args.filters);
            const statuses = asJsonRecord(filters?.status)?.$in;
            const rows = meetings.filter((meeting) =>
              (!filters?.id || meeting.id === filters.id)
              && (!filters?.parentId || meeting.parentId === filters.parentId)
              && (!Array.isArray(statuses) || statuses.includes(meeting.status)),
            );
            return { list: rows.map((meeting) => ({ ...meeting })), total: rows.length };
          }
        }
        if (name === "search_meetings") {
          return { meetings: [
            { id: "external-busy", status: "Planned", dateStart: "2026-10-24T11:00:00", dateEnd: "2026-10-24T14:30:00" },
            ...meetings.filter((meeting) => ["Planned", "Confirmed", "Held"].includes(String(meeting.status))),
          ].map((meeting) => ({ ...meeting })) };
        }
        if (name === "create_meeting") {
          writes.push({ ...args });
          if (mode === "rejected" && writes.length === 2) {
            return { error: "This meeting is outside working hours." };
          }
          const row = { ...args, id: "meeting-" + writes.length };
          if (mode === "stored-duration" && writes.length === 2) row.dateEnd = "2026-10-26T11:30:00";
          if (mode === "stored-service" && writes.length === 2) row.cServicesIds = [CONSULTATION_SERVICE_ID];
          meetings.push(row);
          return { ...row, success: true };
        }
        if (name === "update_meeting") {
          const meeting = meetings.find((row) => row.id === args.meetingId)!;
          Object.assign(meeting, args);
          return { success: true, id: meeting.id };
        }
        throw new Error("Unexpected offline MCP call " + name);
      },
    };
    const checkpointer = new MemorySaver();
    const config = { assignedUserId: "doctor-offline" } as AppConfig;
    const agentTools = buildClinicAgentTools(config, adapters);
    const llm = {
      bindRoutingTools: () => ({ invoke: async () => ({ next: "booking" }) }),
      withStructuredOutput: () => ({ invoke: async () => ({
        text: "Не вдалося створити запис.",
        groups: services.map((service) => ({ label: service.name, serviceIds: [service.id] })),
        serviceIds: [procedure.id],
      }) }),
    } as unknown as ILLMConnector;
    const specialists: ClinicSpecialists = {
      faq: { id: "faq", name: "FAQ", description: "FAQ", systemPrompt: "faq", maxSteps: 4 },
      booking: { id: "booking", name: "Booking", description: "Booking", systemPrompt: "book", maxSteps: 10 },
    };
    const { graph } = compileClinicGraph({
      specialists, agentTools,
      agentModel: { bindTools: () => ({ invoke: async () => new AIMessage("ok") }) } as unknown as BaseChatModel,
      supervisorLlm: llm, assignedUserId: config.assignedUserId,
      formatSystemMetadata: () => "META", messageHistoryMaxTokens: 6000, checkpointer,
      bookingPrefetchCallTool: (name, args) => adapters.callTool(name, args),
      interpretBookingTurn: async (input) => {
        const deterministic = interpretBookingTurnDeterministic(input);
        return Object.keys(deterministic).length > 0
          ? deterministic
          : { serviceIntent: { kind: "named_procedure", query: procedure.name } };
      },
    });
    const runtime: ClinicRuntime = {
      getGraph: () => graph, getCheckpointer: () => checkpointer,
      getBootstrap: () => ({ config, adapters, specialists, agentTools }),
      shutdownAdapters: adapters.shutdown,
    };
    try {
      const running = scenario.run({
        runtime, callTool: (name, args) => adapters.callTool(name, args),
        cleanup: { trackMeeting: () => {}, trackContact: () => {}, run: async () => {} },
        supportsDeleteEntity: false, writesAllowed: true,
        env: { telegramIdA: "999800000", allowWrites: true, allowRemoteCrm: false, nodeEnv: "test" },
      });
      if (mode !== "success") {
        const errors = {
          rejected: "create_meeting failed: This meeting is outside working hours.",
          "lost-duration": "selected service duration undefinedm, CRM oracle says 60m",
          "stored-duration": "replace-rebook stored meeting: interval 30m, CRM duration oracle says 60m",
          "stored-service": "replace-rebook: stored meeting has the wrong service",
        };
        await expect(running).rejects.toThrow(errors[mode]);
        expect(meetings[0]?.status).toBe("Not Held");
        expect(writes).toHaveLength(mode === "lost-duration" ? 1 : 2);
        return;
      }
      await running;
      const isReplacement = scenario.name !== "book-procedure";
      expect(writes).toHaveLength(isReplacement ? 2 : 1);
      if (isReplacement) {
        expect(writes[0]).toMatchObject({ dateStart: "2026-10-24T14:30:00", dateEnd: "2026-10-24T15:00:00" });
      }
      expect(writes.at(-1)).toMatchObject({ dateStart: "2026-10-26T11:00:00", dateEnd: "2026-10-26T12:00:00", cServicesIds: [procedure.id] });
      expect(meetings.map((meeting) => meeting.status)).toEqual(isReplacement ? ["Not Held", "Planned"] : ["Planned"]);
    } finally {
      vi.useRealTimers();
    }
  },
  30_000,
);

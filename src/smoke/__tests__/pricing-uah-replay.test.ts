import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import { expect, it } from "vitest";
import { buildClinicAgentTools } from "../../composition/clinic-agent-tools.js";
import type { ClinicAdapters } from "../../composition/clinic-adapters.js";
import type { ClinicRuntime } from "../../composition/clinic-runtime.js";
import type { AppConfig } from "../../config.js";
import { compileClinicGraph } from "../../graph/compile.js";
import { interpretBookingTurnDeterministic } from "../../graph/booking-domain/interpret.js";
import type { ClinicSpecialists, ILLMConnector } from "../../graph/types.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import {
  faqPriceUahScenario, faqPriceUahUnavailableScenario,
  offerPriceUahScenario, offerPriceUahUnavailableScenario,
} from "../scenarios/pricing-uah.js";

// Run the actual scenario/adapter/graph/tool stack. Only CRM and model responses are fixtures.
it.each([faqPriceUahScenario, faqPriceUahUnavailableScenario, offerPriceUahScenario, offerPriceUahUnavailableScenario])(
  "$name runs through real tool messages without exposing wrappers as prices",
  async (scenario) => {
    const services = [
      { id: CONSULTATION_SERVICE_ID, name: "Консультація", duration: 30 },
      { id: "botox-one-zone", name: "Ботулінотерапія Botox, Disport  1 зона", duration: 30 },
      { id: "botox-two-zones", name: "Ботулінотерапія Botox, Disport 2 зони", duration: 45 },
    ];
    const target = services[1]!;
    const forwarded: string[] = [];
    const adapters: ClinicAdapters = {
      shutdown: async () => {},
      callTool: async (name, args) => {
        forwarded.push(name);
        if (name === "search_contacts") return { contacts: [] };
        if (name === "search_meetings") return { meetings: [] };
        if (name === "search_entity" && args.entityType === "cService") return { list: services, total: services.length };
        if (name === "search_entity" && args.entityType === "Meeting") return { list: [], total: 0 };
        if (name === "get_entity" && args.entityType === "cService" && args.entityId === target.id) {
          return { ...target, price: 100, priceCurrency: "USD", priceConverted: 100, priceUah: 999 };
        }
        throw new Error("Unexpected pricing replay CRM call: " + name);
      },
    };
    const config = { assignedUserId: "pricing-fixture" } as AppConfig;
    const agentTools = buildClinicAgentTools(config, adapters);
    const llm = {
      bindRoutingTools: () => ({ invoke: async () => ({ text: "unused" }) }),
      withStructuredOutput: () => ({ invoke: async () => ({
        serviceIds: [target.id],
        groups: services.map((service) => ({ label: service.name, serviceIds: [service.id] })),
      }) }),
    } as unknown as ILLMConnector;
    const specialists: ClinicSpecialists = {
      faq: { id: "faq", name: "FAQ", description: "FAQ", systemPrompt: "faq", maxSteps: 4 },
      booking: { id: "booking", name: "Booking", description: "Booking", systemPrompt: "booking", maxSteps: 10 },
    };
    const modelInputs: BaseMessage[][] = [];
    const model = {
      bindTools: () => ({ invoke: async (messages: BaseMessage[]) => {
        modelInputs.push(messages);
        const last = messages.at(-1);
        if (last instanceof ToolMessage && last.name === "get_service") {
          const payload = JSON.parse(String(last.content));
          return new AIMessage(payload.error
            ? "Зараз вартість недоступна. Спробуйте пізніше."
            : "Вартість становить " + payload.price + " грн.");
        }
        return new AIMessage({ content: "", tool_calls: [
          { id: "price-call", name: "get_service", args: { serviceId: target.id }, type: "tool_call" },
        ] });
      } }),
    } as unknown as BaseChatModel;
    const checkpointer = new MemorySaver();
    const { graph } = compileClinicGraph({
      specialists, agentTools, agentModel: model, supervisorLlm: llm,
      assignedUserId: config.assignedUserId, checkpointer, messageHistoryMaxTokens: 6000,
      formatSystemMetadata: () => "META",
      bookingPrefetchCallTool: (name, args) => adapters.callTool(name, args),
      interpretBookingTurn: async (input) => {
        const deterministic = interpretBookingTurnDeterministic(input);
        if (Object.keys(deterministic).length > 0) return deterministic;
        return input.rawText === "вартість яка"
          ? { informationalQuestion: input.rawText, faqTopic: "price" }
          : { idleFaq: { question: input.rawText, topic: "price" } };
      },
    });
    const runtime: ClinicRuntime = {
      getGraph: () => graph, getCheckpointer: () => checkpointer,
      getBootstrap: () => ({ config, adapters, agentTools, specialists }), shutdownAdapters: adapters.shutdown,
    };
    await scenario.run({
      runtime, callTool: (name, args) => adapters.callTool(name, args),
      cleanup: { trackMeeting: () => {}, trackContact: () => {}, run: async () => {} },
      writesAllowed: false, supportsDeleteEntity: false,
      env: { telegramIdA: "999800000", allowWrites: false, allowRemoteCrm: false, nodeEnv: "test" },
    });
    expect(forwarded.every((name) => ["search_contacts", "search_meetings", "search_entity", "get_entity"].includes(name))).toBe(true);
    for (const messages of modelInputs) {
      for (const message of messages) {
        if (message instanceof ToolMessage && message.name === "get_service") {
          expect(String(message.content)).not.toMatch(/USD|priceConverted|priceUah/);
        }
      }
    }
  }, 30_000,
);

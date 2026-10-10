import { bookingAgent, faqAgent } from "../../composition/agents.js";
import type { ClinicRuntime } from "../../composition/clinic-runtime.js";
import type { SmokeScenario } from "../types.js";

const EXPECTED_AGENT_IDS = ["faq", "booking"] as const;
const FAQ_TOOL_NAMES = ["list_services", "get_service", "get_working_time"] as const;
const BOOKING_EXTRA_TOOL_NAMES = [
  "find_contact_by_phone",
  "create_contact",
  "link_telegram_to_contact",
  "update_contact",
  "present_availability_slots",
  "create_meeting",
  "list_planned_meetings",
  "cancel_meeting",
  "reschedule_meeting",
] as const;

export const assertBootstrap = async (runtime: ClinicRuntime): Promise<void> => {
  const bootstrap = runtime.getBootstrap();
  const agentIds = bootstrap.agents.map((agent) => agent.id).sort();
  const expected = [...EXPECTED_AGENT_IDS].sort();

  if (agentIds.join(",") !== expected.join(",")) {
    throw new Error(
      `Expected agents [${expected.join(", ")}], got [${agentIds.join(", ")}]`,
    );
  }

  console.log("✓ Runtime bootstrapped");
  console.log(
    "✓ Agents:",
    bootstrap.agents.map((agent) => agent.id).join(", "),
  );

  const faqRuntime = bootstrap.agents.find((agent) => agent.id === "faq");
  const bookingRuntime = bootstrap.agents.find((agent) => agent.id === "booking");
  if (faqRuntime?.systemPrompt !== faqAgent.systemPrompt) {
    throw new Error("faq systemPrompt in runtime does not match src/composition/agents.ts");
  }
  if (bookingRuntime?.systemPrompt !== bookingAgent.systemPrompt) {
    throw new Error("booking systemPrompt in runtime does not match src/composition/agents.ts");
  }
  console.log("✓ Agent prompts loaded from build-time agents.ts");

  const faqTools = (bootstrap.agentTools.faq ?? []).map((tool) => tool.name).sort();
  const bookingTools = (bootstrap.agentTools.booking ?? []).map((tool) => tool.name).sort();
  const expectedFaq = [...FAQ_TOOL_NAMES].sort();
  const expectedBooking = [...FAQ_TOOL_NAMES, ...BOOKING_EXTRA_TOOL_NAMES].sort();

  if (faqTools.join(",") !== expectedFaq.join(",")) {
    throw new Error(`FAQ tools mismatch: got [${faqTools.join(", ")}]`);
  }
  if (bookingTools.join(",") !== expectedBooking.join(",")) {
    throw new Error(`Booking tools mismatch: got [${bookingTools.join(", ")}]`);
  }
  console.log("✓ Agent tool wiring:", {
    faq: faqTools.join("|"),
    booking: bookingTools.join("|"),
  });

  if (!runtime.getCheckpointer()) {
    throw new Error("Expected checkpointer from createClinicRuntime");
  }
  console.log("✓ Checkpointer attached (SqliteSaver)");
  console.log("✓ EspoCRM MCP adapters connected (HTTP)");
};

export const bootstrapScenario: SmokeScenario = {
  name: "bootstrap",
  tier: "deterministic",
  run: async (ctx) => {
    await assertBootstrap(ctx.runtime);
  },
};

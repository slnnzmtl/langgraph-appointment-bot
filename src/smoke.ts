import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";

import { loadConfig } from "./config.js";
import {
  buildClinicCapabilityProviders,
  ESPOCRM_BOOKING_CAPABILITY_ID,
  ESPOCRM_READ_CAPABILITY_ID,
} from "./composition/clinic-capability-providers.js";
import { createClinicPackRuntime } from "./composition/clinic-pack.js";

const EXPECTED_AGENT_IDS = ["faq", "booking"] as const;

const EXPECTED_CAPS: Record<(typeof EXPECTED_AGENT_IDS)[number], string> = {
  faq: ESPOCRM_READ_CAPABILITY_ID,
  booking: ESPOCRM_BOOKING_CAPABILITY_ID,
};

const FAQ_TOOL_NAMES = ["list_services", "get_service"] as const;
const BOOKING_TOOL_NAMES = [
  "find_contact_by_telegram",
  "find_contact_by_phone",
  "create_contact",
  "link_telegram_to_contact",
  "create_meeting",
] as const;

const main = async (): Promise<void> => {
  const config = loadConfig();
  const runtime = await createClinicPackRuntime(config);
  const bootstrap = runtime.getBootstrap();
  const agentIds = bootstrap.runtimeAgents.map((agent) => agent.id).sort();
  const expected = [...EXPECTED_AGENT_IDS].sort();

  if (agentIds.join(",") !== expected.join(",")) {
    throw new Error(
      `Expected seeded agents [${expected.join(", ")}], got [${agentIds.join(", ")}]`,
    );
  }

  console.log("✓ Runtime bootstrapped");
  console.log(
    "✓ Seeded agents:",
    bootstrap.runtimeAgents
      .map((agent) => `${agent.id} [caps=${agent.capabilityIds.join("|")}]`)
      .join(", "),
  );

  for (const agent of bootstrap.runtimeAgents) {
    const expectedCap = EXPECTED_CAPS[agent.id as keyof typeof EXPECTED_CAPS];
    if (!expectedCap || !agent.capabilityIds.includes(expectedCap)) {
      throw new Error(
        `Agent ${agent.id} expected capability ${expectedCap}, got [${agent.capabilityIds.join(", ")}]`,
      );
    }
  }
  console.log("✓ Persisted capability ids migrated (espocrm-read / espocrm-booking)");

  const providers = buildClinicCapabilityProviders({
    config,
    adapters: bootstrap.adapters,
  });
  const readProvider = providers.find(
    (provider) => provider.descriptor.id === ESPOCRM_READ_CAPABILITY_ID,
  );
  const bookingProvider = providers.find(
    (provider) => provider.descriptor.id === ESPOCRM_BOOKING_CAPABILITY_ID,
  );

  if (!readProvider || !bookingProvider) {
    throw new Error("Missing espocrm-read or espocrm-booking capability provider");
  }

  const faqTools = readProvider.resolveTools({})
    .map((tool) => tool.name)
    .sort();
  const bookingTools = bookingProvider.resolveTools({})
    .map((tool) => tool.name)
    .sort();

  const expectedFaq = [...FAQ_TOOL_NAMES].sort();
  const expectedBooking = [...BOOKING_TOOL_NAMES].sort();

  if (faqTools.join(",") !== expectedFaq.join(",")) {
    throw new Error(`FAQ tools mismatch: got [${faqTools.join(", ")}]`);
  }
  if (bookingTools.join(",") !== expectedBooking.join(",")) {
    throw new Error(`Booking tools mismatch: got [${bookingTools.join(", ")}]`);
  }
  if (
    bookingTools.some((name) =>
      (FAQ_TOOL_NAMES as readonly string[]).includes(name),
    )
  ) {
    throw new Error("Booking capability must not include FAQ-only tools");
  }
  console.log("✓ Capability tool resolution:", {
    faq: faqTools.join("|"),
    booking: bookingTools.join("|"),
  });

  if (bookingProvider.descriptor.grantable !== false) {
    throw new Error("espocrm-booking must be grantable: false");
  }
  console.log("✓ espocrm-booking is grantable: false");

  if (!runtime.getCheckpointer()) {
    throw new Error("Expected default MemorySaver checkpointer from createSupervisorRuntime");
  }
  console.log("✓ Checkpointer attached (default MemorySaver)");
  console.log("✓ EspoCRM MCP adapters connected (stdio)");

  await runtime.shutdownAdapters();
  console.log("✓ shutdownAdapters completed");

  const shouldInvoke = process.argv.includes("--invoke");
  if (!shouldInvoke) {
    console.log("Skip LLM invoke (pass --invoke to exercise supervisor routing).");
    return;
  }

  const liveRuntime = await createClinicPackRuntime(config);
  try {
    const graph = liveRuntime.getGraph();
    const result = await graph.invoke(
      { messages: [new HumanMessage("What are your clinic hours?")] },
      { configurable: { thread_id: "smoke-phase2" } },
    );

    const lastMessage = result.messages.at(-1);
    const content =
      typeof lastMessage?.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage?.content ?? null);

    console.log("✓ Graph invoke completed");
    console.log("Last reply:", content.slice(0, 500));
  } finally {
    await liveRuntime.shutdownAdapters();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

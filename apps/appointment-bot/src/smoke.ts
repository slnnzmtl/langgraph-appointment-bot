import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";

import { loadConfig } from "./config.js";
import { createClinicPackRuntime } from "./composition/clinic-pack.js";

const EXPECTED_AGENT_IDS = ["faq", "booking"] as const;

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

  if (!runtime.getCheckpointer()) {
    throw new Error("Expected default MemorySaver checkpointer from createSupervisorRuntime");
  }
  console.log("✓ Checkpointer attached (default MemorySaver)");

  const shouldInvoke = process.argv.includes("--invoke");
  if (!shouldInvoke) {
    console.log("Skip LLM invoke (pass --invoke to exercise supervisor routing).");
    return;
  }

  const graph = runtime.getGraph();
  const result = await graph.invoke(
    { messages: [new HumanMessage("What are your clinic hours?")] },
    { configurable: { thread_id: "smoke-phase1" } },
  );

  const lastMessage = result.messages.at(-1);
  const content =
    typeof lastMessage?.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage?.content ?? null);

  console.log("✓ Graph invoke completed");
  console.log("Last reply:", content.slice(0, 500));
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

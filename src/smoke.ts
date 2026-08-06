import "dotenv/config";
import { randomUUID } from "node:crypto";

import { HumanMessage } from "@langchain/core/messages";

import { loadConfig } from "./config.js";
import type { ClinicAdapters, McpCallTool } from "./composition/clinic-adapters.js";
import {
  buildClinicCapabilityProviders,
  ESPOCRM_BOOKING_CAPABILITY_ID,
  ESPOCRM_READ_CAPABILITY_ID,
} from "./composition/clinic-capability-providers.js";
import { createClinicPackRuntime, type ClinicRuntime } from "./composition/clinic-pack.js";
import { FAQ_SYSTEM_PROMPT } from "./prompts/faq.js";
import { BOOKING_SYSTEM_PROMPT } from "./prompts/booking.js";
import {
  clearTelegramUserId,
  setTelegramUserId,
} from "./tools/telegram-user-context.js";

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
  "present_availability_slots",
  "create_meeting",
] as const;

type CallRecord = { name: string; args: Record<string, unknown> };

const lastAiText = (messages: Array<{ content?: unknown }>): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
  }
  return "";
};

/** English uses \\b; Cyrillic cannot (JS \\w is ASCII-only), so match Ukrainian stems bare. */
const softPhoneHeuristic = (text: string): boolean =>
  /(?:\bphone\b|телефон|номер)/i.test(text);

const installCallToolRecorder = (
  adapters: ClinicAdapters,
): { calls: CallRecord[]; restore: () => void } => {
  const calls: CallRecord[] = [];
  const original = adapters.callTool;
  const wrapped: McpCallTool = async (name, args) => {
    calls.push({ name, args });
    return original(name, args);
  };
  adapters.callTool = wrapped;
  return {
    calls,
    restore: () => {
      adapters.callTool = original;
    },
  };
};

const assertBootstrap = async (runtime: ClinicRuntime): Promise<void> => {
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

  const faqAgent = bootstrap.runtimeAgents.find((agent) => agent.id === "faq");
  const bookingAgent = bootstrap.runtimeAgents.find((agent) => agent.id === "booking");
  if (faqAgent?.systemPrompt !== FAQ_SYSTEM_PROMPT) {
    throw new Error("faq systemPrompt in runtime-agents.json does not match src/prompts/faq.ts");
  }
  if (bookingAgent?.systemPrompt !== BOOKING_SYSTEM_PROMPT) {
    throw new Error(
      "booking systemPrompt in runtime-agents.json does not match src/prompts/booking.ts",
    );
  }
  console.log("✓ runtime-agents.json systemPrompt synced with TS prompt modules");

  const providers = buildClinicCapabilityProviders({
    config: bootstrap.config,
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
};

const shortTelegramId = (prefixDigit: string): string =>
  `${prefixDigit}${Date.now().toString().slice(-9)}`;

const contactHits = (search: unknown): unknown[] => {
  if (!search || typeof search !== "object") {
    return [];
  }
  const record = search as { contacts?: unknown; list?: unknown };
  if (Array.isArray(record.contacts)) {
    return record.contacts;
  }
  if (Array.isArray(record.list)) {
    return record.list;
  }
  return [];
};

const ensureKnownContact = async (
  callTool: McpCallTool,
  telegramId: string,
): Promise<void> => {
  const search = await callTool("search_contacts", { cTelegram: telegramId, limit: 5 });
  if (contactHits(search).length > 0) {
    console.log(`✓ Known contact already exists for cTelegram=${telegramId}`);
    return;
  }

  await callTool("create_contact", {
    firstName: "Smoke",
    lastName: "Known",
    cTelegram: telegramId,
    skipDuplicateCheck: true,
  });
  console.log(`✓ Created known contact for cTelegram=${telegramId}`);
};

const invokeBooking = async (
  graph: ReturnType<ClinicRuntime["getGraph"]>,
  telegramId: string,
  threadId: string,
  utterance: string,
): Promise<{ reply: string; recursionHit: boolean }> => {
  setTelegramUserId(telegramId);
  try {
    const result = await graph.invoke(
      { messages: [new HumanMessage(utterance)] },
      { configurable: { thread_id: threadId }, recursionLimit: 40 },
    );
    return {
      reply: lastAiText(result.messages as Array<{ content?: unknown }>),
      recursionHit: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Recursion limit")) {
      return { reply: "", recursionHit: true };
    }
    throw error;
  }
};

const assertFirstTelegramSearch = (
  label: string,
  calls: CallRecord[],
  telegramId: string,
): void => {
  const first = calls[0];
  if (!first || first.name !== "search_contacts") {
    throw new Error(
      `${label}: expected first MCP call search_contacts, got ${first?.name ?? "none"} (calls=${calls.map((c) => c.name).join(",") || "none"})`,
    );
  }
  if (first.args.cTelegram !== telegramId) {
    throw new Error(
      `${label}: expected cTelegram=${telegramId}, got ${String(first.args.cTelegram)}`,
    );
  }
};

const runIdentitySmoke = async (runtime: ClinicRuntime): Promise<void> => {
  const bootstrap = runtime.getBootstrap();
  const graph = runtime.getGraph();
  const { calls, restore } = installCallToolRecorder(bootstrap.adapters);

  try {
    const knownId = process.env.SMOKE_KNOWN_TELEGRAM_ID?.trim() || shortTelegramId("9");
    await ensureKnownContact(bootstrap.adapters.callTool, knownId);

    // --- Known path ---
    calls.length = 0;
    const known = await invokeBooking(
      graph,
      knownId,
      `smoke-identity-known-${randomUUID().slice(0, 8)}`,
      "I want to book an appointment. Start by looking up my contact.",
    );
    assertFirstTelegramSearch("Known path", calls, knownId);
    if (calls.some((call) => call.name === "create_contact")) {
      throw new Error("Known path: must not call create_contact on first turn");
    }
    console.log("✓ Known path hard asserts (search_contacts + no create_contact)");
    if (known.recursionHit) {
      console.warn("⚠ Soft: known path hit recursion limit after identity tools ran");
    }
    if (known.reply && softPhoneHeuristic(known.reply)) {
      console.warn(
        "⚠ Soft: known-path reply mentions phone — expected skip contact questions:",
        known.reply.slice(0, 200),
      );
    } else if (known.reply) {
      console.log("✓ Soft: known-path reply does not ask for phone");
    }

    // --- Unknown path ---
    calls.length = 0;
    const unknownId = shortTelegramId("8");
    const unknown = await invokeBooking(
      graph,
      unknownId,
      `smoke-identity-unknown-${randomUUID().slice(0, 8)}`,
      "I want to book an appointment. Start by looking up my contact.",
    );
    assertFirstTelegramSearch("Unknown path", calls, unknownId);
    if (calls.some((call) => call.name === "create_contact")) {
      throw new Error(
        "Unknown path: must not call create_contact before phone/name are provided",
      );
    }
    console.log("✓ Unknown path hard asserts (search_contacts + no create_contact)");
    if (unknown.recursionHit) {
      console.warn("⚠ Soft: unknown path hit recursion limit after identity tools ran");
    }
    if (unknown.reply && softPhoneHeuristic(unknown.reply)) {
      console.log("✓ Soft: unknown-path reply asks for phone");
    } else if (unknown.reply) {
      console.warn(
        "⚠ Soft: unknown-path reply did not clearly ask for phone:",
        unknown.reply.slice(0, 200),
      );
    }
  } finally {
    restore();
    clearTelegramUserId();
  }
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const shouldInvoke = process.argv.includes("--invoke");
  const shouldIdentity = process.argv.includes("--identity");

  const runtime = await createClinicPackRuntime(config);
  try {
    await assertBootstrap(runtime);

    if (!shouldInvoke && !shouldIdentity) {
      console.log("Skip LLM invoke (pass --invoke or --identity).");
      return;
    }

    if (shouldInvoke) {
      const graph = runtime.getGraph();
      const result = await graph.invoke(
        { messages: [new HumanMessage("What are your clinic hours?")] },
        { configurable: { thread_id: `smoke-faq-${randomUUID().slice(0, 8)}` } },
      );

      const content = lastAiText(result.messages as Array<{ content?: unknown }>);
      console.log("✓ Graph invoke completed (--invoke)");
      console.log("Last reply:", content.slice(0, 500));
    }

    if (shouldIdentity) {
      await runIdentitySmoke(runtime);
      console.log("✓ Identity smoke completed (--identity)");
    }
  } finally {
    await runtime.shutdownAdapters();
    console.log("✓ shutdownAdapters completed");
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

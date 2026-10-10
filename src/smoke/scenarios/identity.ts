import { randomUUID } from "node:crypto";

import { HumanMessage } from "@langchain/core/messages";

import { soft } from "../assert.js";
import { ensureSmokeContact, findContactByTelegram } from "../crm.js";
import { isIsolatedSmokeTelegramId, writeTelegramId } from "../env.js";
import { installCallToolRecorder } from "../harness.js";
import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import type { SoftWarning, SmokeScenario } from "../types.js";

const softPhoneHeuristic = (text: string): boolean =>
  /(?:\bphone\b|телефон|номер)/i.test(text);

const lastAiText = (messages: Array<{ content?: unknown }>): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
  }
  return "";
};

export const identityScenario: SmokeScenario = {
  name: "identity",
  tier: "invoke",
  run: async (ctx) => {
    const warnings: SoftWarning[] = [];
    const bootstrap = ctx.runtime.getBootstrap();
    const graph = ctx.runtime.getGraph();
    const { calls, drain, restore } = installCallToolRecorder(bootstrap.adapters);

    try {
      const knownId = ctx.env.knownTelegramId ?? ctx.env.telegramIdA;
      if (isIsolatedSmokeTelegramId(knownId)) {
        const existing = await findContactByTelegram(ctx.callTool, knownId);
        if (existing) {
          ctx.cleanup.trackContact(existing.id);
        } else if (ctx.env.allowWrites) {
          const contact = await ensureSmokeContact(ctx.callTool, knownId);
          ctx.cleanup.trackContact(contact.id);
        } else {
          throw new Error(
            "identity: known smoke telegram id has no Contact — set SMOKE_KNOWN_TELEGRAM_ID to an existing Contact, or SMOKE_ALLOW_WRITES=1 to seed Smoke Tester",
          );
        }
      } else {
        const existing = await findContactByTelegram(ctx.callTool, knownId);
        if (!existing) {
          throw new Error(
            "identity: SMOKE_KNOWN_TELEGRAM_ID is not a 9998… smoke id and has no Contact — refusing to create a Contact on a real telegram id",
          );
        }
      }

      drain();
      const known = await runWithTelegramUserId(knownId, async () => {
        try {
          const result = await graph.invoke(
            {
              messages: [
                new HumanMessage(
                  "I want to book an appointment. Start by looking up my contact.",
                ),
              ],
            },
            {
              configurable: { thread_id: `smoke-identity-known-${randomUUID().slice(0, 8)}` },
              recursionLimit: 40,
              runName: "clinic-turn",
              tags: ["smoke", "smoke:identity"],
              metadata: {
                telegram_user_id: knownId,
                chat_id: "smoke-identity-known",
                source: "smoke",
              },
            },
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
      });

      const knownCalls = [...calls];
      const firstKnown = knownCalls[0];
      if (!firstKnown || firstKnown.name !== "search_contacts") {
        throw new Error(
          `Known path: expected first MCP call search_contacts, got ${firstKnown?.name ?? "none"}`,
        );
      }
      if (firstKnown.args.cTelegram !== knownId) {
        throw new Error(
          `Known path: expected cTelegram=${knownId}, got ${String(firstKnown.args.cTelegram)}`,
        );
      }
      if (knownCalls.some((call) => call.name === "create_contact")) {
        throw new Error("Known path: must not call create_contact on first turn");
      }
      console.log("✓ Known path hard asserts (search_contacts + no create_contact)");
      if (known.recursionHit) {
        soft(warnings, "known path hit recursion limit after identity tools ran", false);
      }
      if (known.reply && softPhoneHeuristic(known.reply)) {
        soft(
          warnings,
          "known-path reply mentions phone — expected skip contact questions",
          false,
          known.reply.slice(0, 200),
        );
      } else if (known.reply) {
        console.log("✓ Soft: known-path reply does not ask for phone");
      }

      drain();
      const unknownId = writeTelegramId("8");
      const unknown = await runWithTelegramUserId(unknownId, async () => {
        try {
          const result = await graph.invoke(
            {
              messages: [
                new HumanMessage(
                  "I want to book an appointment. Start by looking up my contact.",
                ),
              ],
            },
            {
              configurable: {
                thread_id: `smoke-identity-unknown-${randomUUID().slice(0, 8)}`,
              },
              recursionLimit: 40,
              runName: "clinic-turn",
              tags: ["smoke", "smoke:identity"],
              metadata: {
                telegram_user_id: unknownId,
                chat_id: "smoke-identity-unknown",
                source: "smoke",
              },
            },
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
      });

      const unknownCalls = [...calls];
      const firstUnknown = unknownCalls[0];
      if (!firstUnknown || firstUnknown.name !== "search_contacts") {
        throw new Error(
          `Unknown path: expected first MCP call search_contacts, got ${firstUnknown?.name ?? "none"}`,
        );
      }
      if (firstUnknown.args.cTelegram !== unknownId) {
        throw new Error(
          `Unknown path: expected cTelegram=${unknownId}, got ${String(firstUnknown.args.cTelegram)}`,
        );
      }
      if (unknownCalls.some((call) => call.name === "create_contact")) {
        throw new Error(
          "Unknown path: must not call create_contact before phone/name are provided",
        );
      }
      console.log("✓ Unknown path hard asserts (search_contacts + no create_contact)");
      if (unknown.recursionHit) {
        soft(warnings, "unknown path hit recursion limit after identity tools ran", false);
      }
      if (unknown.reply && softPhoneHeuristic(unknown.reply)) {
        console.log("✓ Soft: unknown-path reply asks for phone");
      } else if (unknown.reply) {
        soft(
          warnings,
          "unknown-path reply did not clearly ask for phone",
          false,
          unknown.reply.slice(0, 200),
        );
      }
    } finally {
      restore();
    }

    return { warnings };
  },
};

import { isBaseMessage } from "@langchain/core/messages";
import { extractRawMessageText } from "../../shared/message-content.js";

import { BOOKING_OFFER_MENU } from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { SmokeAssertError, expectButtons, expectNotCalled } from "../assert.js";
import { writeTelegramId } from "../env.js";
import { createSmokeSession, installCallToolRecorder } from "../harness.js";
import type { SmokeScenario } from "../types.js";
import type { TurnResult } from "../harness.js";
import { openBookingOffer } from "./offer-helpers.js";

const isCServiceGet = (call: { name: string; args: Record<string, unknown> }): boolean =>
  call.name === "get_entity" && call.args.entityType === "cService";

const FX_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";
const FX_RATE = 43.27;
const TARGET_NAME = /^Ботулінотерапія\s+Botox,\s*Disport\s+1\s+зона$/iu;
const READ_TOOLS = new Set([
  "search_contacts", "search_meetings", "search_entity", "get_entity", "get_working_time",
]);
const WRITE_TOOLS = [
  "create_meeting", "update_meeting", "create_contact", "update_contact", "update_entity",
  "cancel_meeting", "reschedule_meeting", "delete_entity", "delete_meeting", "delete_contact",
] as const;

type PriceFixture = { id: string; name: string; sourcePrice: number; sourceCurrency: "USD"; expectedUah: number };

const scopedFx = (mode: "success" | "unavailable"): { restore: () => void; requests: () => number } => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === FX_URL) {
      requests += 1;
      if (mode === "unavailable") throw new Error("controlled FX outage");
      return new Response(JSON.stringify({ date: "2026-10-24", usd: { uah: FX_RATE } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, requests: () => requests };
};

const loadTarget = async (callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<PriceFixture> => {
  const rawList = await callTool("search_entity", {
    entityType: "cService", select: ["id", "name"], limit: 200,
  });
  const listRecord = asJsonRecord(rawList);
  const rows = Array.isArray(listRecord?.list) ? listRecord.list : Array.isArray(rawList) ? rawList : [];
  const matching = rows.map(asJsonRecord).filter((row) => row && typeof row.id === "string" && typeof row.name === "string" && TARGET_NAME.test(row.name));
  if (matching.length !== 1) {
    throw new SmokeAssertError(`pricing-uah: expected exactly one Botox/Disport 1-zone service, got ${matching.length}`);
  }
  const target = matching[0]!;
  const entity = asJsonRecord(await callTool("get_entity", { entityType: "cService", entityId: target.id }));
  if (!entity || entity.id !== target.id || entity.priceCurrency !== "USD") {
    throw new SmokeAssertError(`pricing-uah: target ${target.id} must independently resolve to a USD-priced CRM service`);
  }
  const sourcePrice = typeof entity.price === "number" ? entity.price : Number(entity.price);
  if (!Number.isFinite(sourcePrice) || sourcePrice <= 0) {
    throw new SmokeAssertError(`pricing-uah: invalid independent CRM source price for ${target.id}`);
  }
  return { id: String(target.id), name: String(target.name), sourcePrice, sourceCurrency: "USD", expectedUah: Math.round(sourcePrice * FX_RATE) };
};

const guardWrites = (adapters: { callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }): (() => void) => {
  const original = adapters.callTool;
  adapters.callTool = async (name, args) => {
    if (!READ_TOOLS.has(name)) throw new SmokeAssertError(`pricing-uah: blocked unexpected MCP call before forwarding: ${name}`);
    return original(name, args);
  };
  return () => { adapters.callTool = original; };
};

export const observeModelFacingGetService = (runtime: Parameters<SmokeScenario["run"]>[0]["runtime"]): {
  outputs: string[];
  restore: () => void;
} => {
  const outputs: string[] = [];
  const tools = runtime.getBootstrap().agentTools;
  const getServiceTools = [...new Set(Object.values(tools).flat().filter((tool) => tool.name === "get_service"))];
  const restores = getServiceTools.map((tool) => {
    const original = tool.invoke;
    tool.invoke = async (...args: Parameters<typeof tool.invoke>) => {
      const result = await original.apply(tool, args);
      // ToolNode calls invoke with a ToolCall, so LangChain returns a ToolMessage.
      // Inspect its content, not its serialized constructor/metadata envelope.
      outputs.push(isBaseMessage(result) && result.getType() === "tool"
        ? extractRawMessageText(result.content)
        : typeof result === "string" ? result : JSON.stringify(result));
      return result;
    };
    return () => { tool.invoke = original; };
  });
  if (getServiceTools.length === 0) {
    throw new SmokeAssertError("pricing-uah: runtime has no get_service tool to observe");
  }
  return { outputs, restore: () => { for (const restore of restores) restore(); } };
};

export const assertModelFacingPrice = (label: string, outputs: string[], fixture: PriceFixture, unavailable: boolean): void => {
  if (outputs.length === 0) throw new SmokeAssertError(`${label}: missing model-facing get_service ToolMessage`);
  for (const output of outputs) {
    const payload = asJsonRecord(output);
    if (unavailable) {
      if (!payload || typeof payload.error !== "string" || Object.keys(payload).some((key) => key !== "error") || /USD|\$|\d/u.test(output)) {
        throw new SmokeAssertError(`${label}: unavailable result exposed price/source details: ${output}`);
      }
      continue;
    }
    const keys = Object.keys(payload ?? {}).sort();
    if (!payload || payload.price !== fixture.expectedUah || payload.currency !== "UAH"
      || keys.some((key) => ["priceUah", "priceConverted", "priceCurrency", "workPrice"].includes(key))
      || output.includes(String(fixture.sourcePrice))) {
      throw new SmokeAssertError(`${label}: model-facing get_service payload is not UAH-only: ${output}`);
    }
  }
};

export const assertQuote = (label: string, reply: string, fixture: PriceFixture, unavailable: boolean): void => {
  if (unavailable) {
    // Accept natural paraphrases, not just the deterministic fallback wording.
    // Keep missing-price language within one clause so unrelated failures do not qualify.
    const statesUnavailable = /не доступ|недоступ|не вдалося визначити|уточнити вартість|price unavailable/iu.test(reply)
      || /не (?:бачу|маю|знаю)[^.!?;\n]{0,60}(?:цін|варт)|(?:цін|варт)[^.!?;\n]{0,60}невідом|price[^.!?;\n]{0,40}unavailable/iu.test(reply);
    if (!statesUnavailable
      || /\d[\d\s\u00a0,.]*\s*(?:грн|uah|usd|\$)/iu.test(reply)) {
      throw new SmokeAssertError(`${label}: expected a clear unavailable-price answer with no quoted amount; got: ${reply}`);
    }
    return;
  }
  const normalized = reply.replace(/[\u00a0\u202f]/gu, " ");
  const quote = /([\d]+(?:[ ,.]\d{3})*(?:[,.]\d+)?)\s*(?:грн|uah)/giu;
  const amounts = [...normalized.matchAll(quote)].map((match) => Number(match[1]!.replace(/[ ,.]/gu, "")));
  if (amounts.length !== 1 || amounts[0] !== fixture.expectedUah || new RegExp(`(?:USD|\\$)\\s*${fixture.sourcePrice}|${fixture.sourcePrice}\\s*(?:USD|\\$)`, "iu").test(reply)) {
    throw new SmokeAssertError(`${label}: expected exactly ${fixture.expectedUah} грн and no source USD quote; got: ${reply}`);
  }
};

const navigateToExactOffer = async (session: ReturnType<typeof createSmokeSession>, targetId: string): Promise<TurnResult> => {
  let turn = await openBookingOffer(session, "pricing-uah");
  turn = await session.tap(BOOKING_OFFER_MENU[1]);
  for (let step = 0; step < 12; step += 1) {
    const pending = turn.state.pendingInteraction;
    if (pending?.kind === "service_confirm") {
      if (pending.service.id !== targetId) throw new SmokeAssertError(`pricing-uah: wrong service selected: ${pending.service.id}`);
      return turn;
    }
    if (pending?.kind !== "service_candidate") break;
    const choice = pending.choices.find((item) => item.serviceIds?.includes(targetId) && turn.buttons.includes(item.label));
    if (choice) {
      turn = await session.tap(choice.label);
      continue;
    }
    const other = pending.choices.find((item) => item.id === "other" && turn.buttons.includes(item.label));
    if (!other) break;
    turn = await session.tap(other.label);
  }
  throw new SmokeAssertError(`pricing-uah: catalog did not reach the exact target ${targetId}`);
};

const makeScenario = (name: string, path: "faq" | "offer", unavailable = false): SmokeScenario => ({
  name,
  tier: "invoke",
  run: async (ctx) => {
    const adapters = ctx.runtime.getBootstrap().adapters;
    const restoreGuard = guardWrites(adapters);
    const fx = scopedFx(unavailable ? "unavailable" : "success");
    const recorder = installCallToolRecorder(adapters, ctx.cleanup);
    let observer: ReturnType<typeof observeModelFacingGetService> | undefined;
    try {
      observer = observeModelFacingGetService(ctx.runtime);
      const fixture = await loadTarget(ctx.callTool);
      const telegramId = writeTelegramId(name);
      const session = createSmokeSession(ctx.runtime, { telegramId, scenario: name, recorder, cleanup: ctx.cleanup });
      let turn: TurnResult;
      if (path === "faq") {
        turn = await session.say(`Яка вартість послуги «${fixture.name}»?`);
      } else {
        const offer = await navigateToExactOffer(session, fixture.id);
        if (offer.state.bookingDraft?.serviceAcceptance?.status === "accepted") {
          throw new SmokeAssertError(`${name}: service was already accepted before the price question`);
        }
        turn = await session.say("вартість яка");
        const pending = turn.state.pendingInteraction;
        if (pending?.kind !== "service_confirm" || pending.service.id !== fixture.id) {
          throw new SmokeAssertError(`${name}: price question lost the selected service`);
        }
        expectButtons(name, turn.buttons, [...BOOKING_OFFER_MENU]);
        if (turn.state.bookingDraft?.serviceAcceptance?.status === "accepted") {
          throw new SmokeAssertError(`${name}: price question advanced/accepted booking`);
        }
      }
      if (!turn.calls.some((call) => isCServiceGet(call) && call.args.entityId === fixture.id)) {
        throw new SmokeAssertError(`${name}: get_service did not fetch the exact target CRM id`);
      }
      expectNotCalled(name, turn.calls, [...WRITE_TOOLS]);
      assertModelFacingPrice(name, observer.outputs, fixture, unavailable);
      assertQuote(name, turn.reply, fixture, unavailable);
      if (fx.requests() === 0) throw new SmokeAssertError(`${name}: target USD price did not trigger the scoped FX lookup`);
      console.log(`✓ ${name}: service=${fixture.id}, source=${fixture.sourcePrice} USD, expected=${unavailable ? "unavailable" : `${fixture.expectedUah} UAH`}, writes=0`);
      return { turns: session.turns };
    } finally {
      observer?.restore();
      recorder.restore();
      fx.restore();
      restoreGuard();
    }
  },
});

export const faqPriceUahScenario = makeScenario("faq-price-uah", "faq");
export const offerPriceUahScenario = makeScenario("offer-price-uah", "offer");
export const offerPriceUahUnavailableScenario = makeScenario("offer-price-uah-unavailable", "offer", true);
export const faqPriceUahUnavailableScenario = makeScenario("faq-price-uah-unavailable", "faq", true);

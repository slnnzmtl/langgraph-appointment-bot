import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTools } from "../../../tools/service-tools.js";
import type { ILLMConnector } from "../../types.js";
import { createBookingRespondNode } from "../booking-respond.js";
import { effectResultFromToolMessages } from "../protocol/effect-result.js";

const source = { name: "Ботулінотерапія Botox, Disport  1 зона", price: 100, priceCurrency: "USD" };
const runTool = async (entity: unknown = source) => {
  const tools = createReadTools({ callTool: async () => entity, assignedUserId: "doctor" });
  return tools.find((tool) => tool.name === "get_service")!.invoke({ serviceId: "botox" });
};
const fxResponse = (rate: unknown) => ({ ok: true, json: async () => ({ usd: { uah: rate } }) });

afterEach(() => { vi.unstubAllGlobals(); });

describe("UAH-only service pricing boundary", () => {
  it.each([false, true])("converts before tool output and booking rendering (JSON=%s)", async (asJson) => {
    vi.stubGlobal("fetch", vi.fn(async () => fxResponse(45.09)));
    const entity = { ...source, priceUah: 999, priceConverted: 100, workPrice: 25 };
    const body = await runTool(asJson ? JSON.stringify(entity) : entity);
    expect(JSON.parse(body)).toEqual({ name: source.name, price: 4509, currency: "UAH" });
    expect(body).not.toContain("USD");
    const result = effectResultFromToolMessages([
      new ToolMessage({ name: "get_service", tool_call_id: "price-1", content: body }),
    ], { id: "price-1", effect: { kind: "get_service", serviceId: "botox" } });
    expect(result?.kind).toBe("informational");
    if (result?.kind !== "informational") throw new Error("Expected informational facts");
    expect(result.facts?.servicePrice).toBe("4509");
    const invoke = vi.fn();
    const node = createBookingRespondNode({
      llm: { bindRoutingTools: () => ({ invoke }) } as unknown as ILLMConnector,
    });
    const update = await node({
      messages: [new HumanMessage("вартість яка")],
      bookingDecision: {
        tag: "reply", intent: "answer_side_question", facts: result.facts,
        card: { kind: "service_confirm", serviceId: "botox", choiceIds: ["offer_accept", "offer_choose_other"] },
      }, bookingDraft: null,
    } as never);
    expect(update.lastHandoff?.replyText).toContain("4509 грн");
    expect(update.lastHandoff?.replyText).not.toContain("100 грн");
    expect(invoke).not.toHaveBeenCalled();
    expect(entity.price).toBe(100);
    expect(entity.priceCurrency).toBe("USD");
  });

  it("normalizes numeric strings without exposing source fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fxResponse(45.09)));
    expect(JSON.parse(await runTool({ ...source, price: "100", priceCurrency: " usd " })))
      .toEqual({ name: source.name, price: 4509, currency: "UAH" });
  });

  it.each([undefined, null, 0, -1, "45.09", NaN, Infinity])("fails closed on invalid FX rate %s", async (rate) => {
    vi.stubGlobal("fetch", vi.fn(async () => fxResponse(rate)));
    const result = JSON.parse(await runTool());
    expect(result).toEqual({ error: "Service price in UAH is unavailable. Please try again later." });
  });

  it.each(["network", "http", "json", "timeout"])("never exposes raw price on %s failure", async (failure) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("USD 100 upstream failure");
      if (failure === "timeout") throw new DOMException("USD 100 timeout", "TimeoutError");
      if (failure === "http") return { ok: false, json: async () => ({ usd: { uah: 45.09 } }) };
      return { ok: true, json: async () => { throw new Error("USD 100 invalid JSON"); } };
    }));
    const body = await runTool();
    expect(JSON.parse(body)).toHaveProperty("error");
    expect(body).not.toMatch(/USD|100/);
  });

  it.each(["", "not-a-price", -1, NaN, Infinity, {}, true])("rejects invalid source price %s", async (price) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(JSON.parse(await runTool({ ...source, price }))).toHaveProperty("error");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["EUR", "", undefined])("does not infer UAH for unsupported or missing currency %s", async (priceCurrency) => {
    expect(JSON.parse(await runTool({ ...source, priceCurrency }))).toHaveProperty("error");
  });

  it.each(["USD 100", '[{"price":100,"priceCurrency":"USD"}]', { error: "USD 100" }, null])(
    "does not pass malformed or error payloads through: %j", async (entity) => {
      const body = await runTool(entity);
      expect(JSON.parse(body)).toHaveProperty("error");
      expect(body).not.toMatch(/USD|100/);
    },
  );

  it("does not pass raw upstream exception messages to the model", async () => {
    const tools = createReadTools({ callTool: async () => { throw new Error("USD 100"); }, assignedUserId: "doctor" });
    const body = await tools.find((tool) => tool.name === "get_service")!.invoke({ serviceId: "botox" });
    expect(JSON.parse(body)).toHaveProperty("error");
    expect(body).not.toMatch(/USD|100/);
  });

  it("does not fetch FX or leak alternate prices for native UAH services", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(JSON.parse(await runTool({ ...source, price: 400, priceCurrency: "UAH", priceUah: 100, priceConverted: 100 })))
      .toEqual({ name: source.name, price: 400, currency: "UAH" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps non-pricing service info when no price is set", async () => {
    expect(JSON.parse(await runTool({ name: source.name, price: null, priceCurrency: "USD" })))
      .toEqual({ name: source.name });
  });
});

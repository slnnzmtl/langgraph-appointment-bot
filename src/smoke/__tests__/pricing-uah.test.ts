import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { SmokeAssertError } from "../assert.js";
import { assertModelFacingPrice, assertQuote, observeModelFacingGetService } from "../scenarios/pricing-uah.js";

const fixture = {
  id: "botox-one-zone",
  name: "Ботулінотерапія Botox, Disport 1 зона",
  sourcePrice: 100,
  sourceCurrency: "USD" as const,
  expectedUah: 4327,
};

const mustFail = (run: () => void): void => {
  expect(run).toThrow(SmokeAssertError);
};

describe("UAH-only pricing smoke contracts", () => {
  it("observes the tool result passed to the model, including shared FAQ/booking tool instances", async () => {
    const tool = {
      name: "get_service",
      invoke: async () => '{"name":"Botox","price":4327,"currency":"UAH"}',
    };
    const runtime = {
      getBootstrap: () => ({ agentTools: { faq: [tool], booking: [tool] } }),
    } as never;
    const observer = observeModelFacingGetService(runtime);
    expect(await tool.invoke()).toContain('"price":4327');
    expect(observer.outputs).toEqual(['{"name":"Botox","price":4327,"currency":"UAH"}']);
    observer.restore();
    expect(await tool.invoke()).toContain('"price":4327');
    expect(observer.outputs).toHaveLength(1);
  });

  it.each([
    { unavailable: false, payload: { name: "Botox", price: 4327, currency: "UAH" } },
    { unavailable: true, payload: { error: "Service price in UAH is unavailable. Please try again later." } },
  ])("reads ToolMessage.content through a real ToolNode (unavailable=$unavailable)", async ({ unavailable, payload }) => {
    const body = JSON.stringify(payload);
    const serviceTool = tool(async () => body, {
      name: "get_service", description: "Service fixture", schema: z.object({ serviceId: z.string() }),
    });
    // Compile the node before installing the observer, as the runtime does.
    const node = new ToolNode([serviceTool], { handleToolErrors: false });
    const originalInvoke = serviceTool.invoke;
    const runtime = {
      getBootstrap: () => ({ agentTools: { faq: [serviceTool], booking: [serviceTool] } }),
    } as never;
    const observer = observeModelFacingGetService(runtime);
    try {
      const result = await node.invoke({ messages: [new AIMessage({ content: "", tool_calls: [
        { id: "call_100", name: "get_service", args: { serviceId: fixture.id }, type: "tool_call" },
      ] })] });
      expect(result.messages[0]).toBeInstanceOf(ToolMessage);
      expect(result.messages[0]!.content).toBe(body);
      expect(observer.outputs).toEqual([body]);
      assertModelFacingPrice("real-tool-node", observer.outputs, fixture, unavailable);
    } finally {
      observer.restore();
    }
    expect(serviceTool.invoke).toBe(originalInvoke);
  });

  it("accepts only the normalized model-facing UAH payload", () => {
    expect(() => assertModelFacingPrice("test", ['{"name":"Botox","price":4327,"currency":"UAH"}'], fixture, false)).not.toThrow();
  });

  it("rejects the old USD payload even if a converted side-field exists", () => {
    mustFail(() => assertModelFacingPrice(
      "test", ['{"name":"Botox","price":100,"currency":"USD","priceUah":4327}'], fixture, false,
    ));
  });

  it("rejects converted values mixed with alternate/source price fields", () => {
    mustFail(() => assertModelFacingPrice(
      "test", ['{"price":4327,"currency":"UAH","priceConverted":100}'], fixture, false,
    ));
    mustFail(() => assertModelFacingPrice(
      "test", ['{"price":4327,"currency":"UAH","workPrice":100}'], fixture, false,
    ));
  });

  it("requires the exact converted quote, not relabeled USD or a repeated conversion", () => {
    expect(() => assertQuote("test", "Вартість становить 4 327 грн.", fixture, false)).not.toThrow();
    mustFail(() => assertQuote("test", "Вартість становить 100 грн.", fixture, false));
    mustFail(() => assertQuote("test", "Вартість становить 187 249 грн.", fixture, false));
    mustFail(() => assertQuote("test", "Вартість становить 100 USD.", fixture, false));
  });

  it.each([
    "На жаль, зараз я не бачу актуальної ціни на цю послугу. Можу передати запитання адміністратору або підказати щось інше?",
    "Зараз не маю актуальної вартості цієї послуги.",
    "Актуальна ціна зараз невідома.",
    "The service price is currently unavailable. Please try again later.",
  ])("accepts an unavailable-price paraphrase: %s", (reply) => {
    expect(() => assertQuote("test", reply, fixture, true)).not.toThrow();
    mustFail(() => assertQuote("test", reply + " Вартість 100 грн.", fixture, true));
    mustFail(() => assertQuote("test", reply + " Вартість 100 USD.", fixture, true));
  });

  it.each([
    "Не бачу вільних слотів. Вартість уточнимо пізніше.",
    "Можу передати запитання адміністратору?",
    "Чудово, обрано послугу. Бажаєте записатися?",
  ])("rejects a reply that does not clearly say pricing is unavailable: %s", (reply) => {
    mustFail(() => assertQuote("test", reply, fixture, true));
  });

  it("requires a clear unavailable result and rejects invented or source-price fallbacks", () => {
    expect(() => assertModelFacingPrice(
      "test", ['{"error":"Service price in UAH is unavailable. Please try again later."}'], fixture, true,
    )).not.toThrow();
    mustFail(() => assertModelFacingPrice("test", ['{"price":100,"currency":"USD"}'], fixture, true));
    expect(() => assertQuote("test", "На жаль, зараз не вдалося визначити вартість.", fixture, true)).not.toThrow();
    mustFail(() => assertQuote("test", "Не вдалося визначити вартість, це 100 грн.", fixture, true));
    mustFail(() => assertQuote("test", "На жаль, 100 USD.", fixture, true));
  });
});

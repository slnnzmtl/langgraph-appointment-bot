import { describe, expect, it, vi } from "vitest";

import type { ILLMConnector } from "../../types.js";
import { createBookingTurnInterpreter } from "../booking-turn-interpreter.js";

describe("createBookingTurnInterpreter open name field", () => {
  it("does not let structured model output provide runtime acceptance or catalog identity", async () => {
    const invoke = vi.fn().mockResolvedValue({
      serviceIntentKind: "book_highlighted",
    });
    let schema: { safeParse: (value: unknown) => { success: boolean } } | undefined;
    const llm = {
      bindRoutingTools: (value: typeof schema) => {
        schema = value;
        return { invoke };
      },
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);

    await expect(interpret({ rawText: "Could you book this one?", faqHighlightOpen: true }))
      .resolves.toEqual({ serviceIntent: { kind: "book_highlighted" } });
    expect(schema?.safeParse({
      serviceIntentKind: "book_highlighted",
      accepted: true,
      serviceId: "model-minted-id",
    }).success)
      .toBe(false);
  });

  it("submits a name only when the model sets firstName; empty omit re-asks", async () => {
    const invoke = vi.fn();
    const llm = {
      bindRoutingTools: () => ({ invoke }),
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);

    invoke.mockResolvedValueOnce({ firstName: "Іван" });
    await expect(
      interpret({ rawText: "Іван", awaitingContactField: "firstName" }),
    ).resolves.toEqual({ contactFacts: { firstName: "Іван" } });

    invoke.mockResolvedValueOnce({ firstName: "Дар'я" });
    await expect(
      interpret({ rawText: "Дар'я", awaitingContactField: "firstName" }),
    ).resolves.toEqual({ contactFacts: { firstName: "Дар'я" } });

    invoke.mockResolvedValueOnce({ firstName: "Smoke" });
    await expect(
      interpret({ rawText: "Smoke", awaitingContactField: "firstName" }),
    ).resolves.toEqual({ contactFacts: { firstName: "Smoke" } });

    // Empty / hedge classifications must not invent a name from raw text.
    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({ rawText: "Smoke", awaitingContactField: "firstName" }),
    ).resolves.toEqual({});

    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({ rawText: "Невідомо", awaitingContactField: "firstName" }),
    ).resolves.toEqual({});

    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({ rawText: "не знаю", awaitingContactField: "firstName" }),
    ).resolves.toEqual({});

    expect(invoke).toHaveBeenCalledTimes(6);
  });

  it("keeps visit_cancel when the model classifies control on the name step", async () => {
    const invoke = vi.fn();
    const llm = {
      bindRoutingTools: () => ({ invoke }),
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);

    invoke.mockResolvedValueOnce({ controlKind: "visit_cancel" });
    await expect(
      interpret({
        rawText: "Скасуйте мій запис",
        awaitingContactField: "firstName",
      }),
    ).resolves.toEqual({ controlIntent: { kind: "visit_cancel" } });

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps structural phone on the deterministic path (no LLM)", async () => {
    const invoke = vi.fn();
    const llm = {
      bindRoutingTools: () => ({ invoke }),
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);

    const patch = await interpret({
      rawText: "+380501112233",
      awaitingContactField: "phoneNumber",
    });
    expect(patch.contactFacts?.phoneNumber).toMatch(/^\+/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("classifies phone-step control prose before issuing a format error", async () => {
    const invoke = vi.fn();
    const llm = {
      bindRoutingTools: () => ({ invoke }),
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);

    invoke.mockResolvedValueOnce({ controlKind: "visit_cancel" });
    await expect(
      interpret({
        rawText: "Скасуйте мій запис",
        awaitingContactField: "phoneNumber",
      }),
    ).resolves.toEqual({ controlIntent: { kind: "visit_cancel" } });

    invoke.mockResolvedValueOnce({ controlKind: "human_handoff" });
    await expect(
      interpret({
        rawText: "Я хочу поговорити з адміністратором",
        awaitingContactField: "phoneNumber",
      }),
    ).resolves.toEqual({ controlIntent: { kind: "human_handoff" } });

    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({
        rawText: "38050504023",
        awaitingContactField: "phoneNumber",
      }),
    ).resolves.toEqual({ contactFormatError: "phoneNumber" });

    expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("retains phone and both names from one explicit compound booking turn", async () => {
    const invoke = vi.fn().mockResolvedValue({
      serviceIntentKind: "named_procedure",
      serviceQuery: "Botox",
      scheduleKind: "date_and_time",
      scheduleDate: "2026-11-02",
      scheduleTime: "13:00",
      phoneNumber: "+380501112233",
      firstName: "Іван",
      lastName: "Петренко",
      sideQuestionKind: "price",
    });
    const llm = {
      bindRoutingTools: () => ({ invoke }),
    } as unknown as ILLMConnector;
    const interpret = createBookingTurnInterpreter(llm);
    await expect(interpret({ rawText: "Book Botox on Nov 2 at 13:00, I'm Ivan Petrenko, +380501112233; price?" }))
      .resolves.toMatchObject({
        serviceIntent: { kind: "named_procedure", query: "Botox" },
        scheduleIntent: { kind: "date_and_time", date: "2026-11-02", time: "13:00" },
        contactFacts: { phoneNumber: "+380501112233", firstName: "Іван", lastName: "Петренко" },
        informationalQuestion: "price",
      });
  });

});

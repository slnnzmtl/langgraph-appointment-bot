import { describe, expect, it, vi } from "vitest";

import type { ILLMConnector } from "../../types.js";
import { createBookingTurnInterpreter } from "../booking-turn-interpreter.js";

describe("createBookingTurnInterpreter open name field", () => {
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
});

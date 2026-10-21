import { describe, expect, it, vi } from "vitest";

import type { ILLMConnector } from "../../types.js";
import { createBookingTurnInterpreter } from "../booking-turn-interpreter.js";

describe("createBookingTurnInterpreter open name field", () => {
  it("applies a model firstName and does not invent one for a hedge", async () => {
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

    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({ rawText: "Невідомо", awaitingContactField: "firstName" }),
    ).resolves.toEqual({});

    invoke.mockResolvedValueOnce({ controlKind: "none" });
    await expect(
      interpret({ rawText: "не знаю", awaitingContactField: "firstName" }),
    ).resolves.toEqual({});

    expect(invoke).toHaveBeenCalledTimes(4);
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
});

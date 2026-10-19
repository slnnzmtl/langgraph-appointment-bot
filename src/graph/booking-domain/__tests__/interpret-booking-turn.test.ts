import { describe, expect, it } from "vitest";

import {
  interpretBookingTurnDeterministic,
  normalizeBookingTurnClassification,
} from "../interpret.js";

describe("interpretBookingTurnDeterministic", () => {
  it("accepts an offered callback choice id and rejects the same label as free text", () => {
    const offered = ["2026-10-24", "confirm", "menu"];
    expect(
      interpretBookingTurnDeterministic({
        rawText: "",
        callbackChoiceId: "2026-10-24",
        offeredChoiceIds: offered,
      }).scheduleIntent,
    ).toEqual({ kind: "date", date: "2026-10-24" });

    // Typed label that is not an offered id must not be matched.
    expect(
      interpretBookingTurnDeterministic({
        rawText: "24 жовтня",
        offeredChoiceIds: offered,
      }),
    ).toEqual({});
  });

  it("rejects a callback id that is not on the current card", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "",
        callbackChoiceId: "stale-slot",
        offeredChoiceIds: ["confirm"],
      }),
    ).toEqual({});
  });

  it("accepts a structural phone while awaiting phoneNumber", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "+380501112233",
      awaitingContactField: "phoneNumber",
    });
    expect(patch.contactFacts?.phoneNumber).toMatch(/^\+/);
  });
});

describe("normalizeBookingTurnClassification (structured LLM)", () => {
  it("does not invent a firstName from hedges while awaiting first name", () => {
    // Deterministic layer never guesses names from free text.
    expect(
      interpretBookingTurnDeterministic({
        rawText: "не знаю",
        awaitingContactField: "firstName",
      }),
    ).toEqual({});
    // Structured LLM that correctly classifies an aside yields no name patch.
    const patch = normalizeBookingTurnClassification(
      { controlKind: "none" },
      { rawText: "не знаю", awaitingContactField: "firstName" },
    );
    expect(patch.contactFacts?.firstName).toBeUndefined();
  });

  it("does not treat a service-change ask as a visit note without awaitingNote", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Хочу змінити послугу",
        awaitingNote: true,
      }),
    ).toEqual({});
    const patch = normalizeBookingTurnClassification(
      {
        noteKind: "none",
        serviceIntentKind: "catalog_browse",
        serviceQuery: "змінити послугу",
      },
      { rawText: "Хочу змінити послугу", awaitingNote: true },
    );
    expect(patch.note).toBeUndefined();
    expect(patch.serviceIntent?.kind).toBe("catalog_browse");
  });

  it("keeps booking + price side question facts from structured classification", () => {
    const patch = normalizeBookingTurnClassification(
      {
        serviceIntentKind: "consultation",
        sideQuestionKind: "price",
      },
      { rawText: "Can I book and what is the price?" },
    );
    expect(patch.serviceIntent?.kind).toBe("consultation");
    expect(patch.informationalQuestion).toBe("price");
  });

  it("maps laser-operator catalog ask to catalog, not human_handoff", () => {
    const patch = normalizeBookingTurnClassification(
      {
        sideQuestionKind: "catalog",
        controlKind: "none",
      },
      { rawText: "Чи працює оператор лазера?" },
    );
    expect(patch.controlIntent).toBeUndefined();
    expect(patch.serviceIntent?.kind).toBe("catalog_browse");
  });
});

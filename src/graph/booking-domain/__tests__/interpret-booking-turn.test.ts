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
  it("leaves free-text names for the structured interpreter; phone stays structural", () => {
    // Deterministic path never accepts names (including hedges and real tokens).
    for (const rawText of ["Невідомо", "Іван", "Дар'я", "Дар’я", "Smoke", "не знаю", "!!!"]) {
      expect(
        interpretBookingTurnDeterministic({
          rawText,
          awaitingContactField: "firstName",
        }),
      ).toEqual({});
    }
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Tester",
        awaitingContactField: "lastName",
      }),
    ).toEqual({});
    // Non-phone / invalid shape stays {} so the structured interpreter can run.
    expect(
      interpretBookingTurnDeterministic({
        rawText: "38050504023",
        awaitingContactField: "phoneNumber",
      }),
    ).toEqual({});
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Скасуйте мій запис",
        awaitingContactField: "phoneNumber",
      }),
    ).toEqual({});
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Я хочу поговорити з адміністратором",
        awaitingContactField: "phoneNumber",
      }),
    ).toEqual({});
    // Main-menu label is control even on open contact fields (no routing LLM).
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Головне меню",
        awaitingContactField: "firstName",
      }),
    ).toEqual({ controlIntent: { kind: "main_menu" } });
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Головне меню",
        awaitingContactField: "phoneNumber",
      }),
    ).toEqual({ controlIntent: { kind: "main_menu" } });
    // Structured LLM applies a clear firstName; hedges yield no name patch.
    expect(
      normalizeBookingTurnClassification(
        { firstName: "Іван" },
        { rawText: "Іван", awaitingContactField: "firstName" },
      ),
    ).toEqual({ contactFacts: { firstName: "Іван" } });
    expect(
      normalizeBookingTurnClassification(
        { firstName: "Дар'я" },
        { rawText: "Дар'я", awaitingContactField: "firstName" },
      ),
    ).toEqual({ contactFacts: { firstName: "Дар'я" } });
    const hedge = normalizeBookingTurnClassification(
      { controlKind: "none" },
      { rawText: "не знаю", awaitingContactField: "firstName" },
    );
    expect(hedge.contactFacts?.firstName).toBeUndefined();
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

  it("maps reply-keyboard Так / Обрати іншу процедуру while awaiting service confirm", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Так",
        awaitingServiceConfirm: true,
        offeredChoiceIds: ["offer_accept", "offer_choose_other"],
      }).serviceIntent,
    ).toEqual({ kind: "confirm_pending_service" });

    expect(
      interpretBookingTurnDeterministic({
        rawText: "Обрати іншу процедуру",
        awaitingServiceConfirm: true,
        offeredChoiceIds: ["offer_accept", "offer_choose_other"],
      }).serviceIntent,
    ).toEqual({ kind: "decline_pending_service" });
  });

  it("resolves session accept callback against kernel offer_accept ids", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Так",
        callbackChoiceId: "accept",
        awaitingServiceConfirm: true,
        offeredChoiceIds: ["offer_accept", "offer_choose_other"],
        offeredChoiceLabels: ["Так", "Обрати іншу процедуру"],
      }).serviceIntent,
    ).toEqual({ kind: "confirm_pending_service" });

    expect(
      interpretBookingTurnDeterministic({
        rawText: "Обрати іншу процедуру",
        callbackChoiceId: "choose_other",
        awaitingServiceConfirm: true,
        offeredChoiceIds: ["offer_accept", "offer_choose_other"],
      }).serviceIntent,
    ).toEqual({ kind: "decline_pending_service" });
  });

  it("keeps an open offer when free text invents catalog/decline", () => {
    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "catalog_browse", serviceQuery: "яку послугу" },
        { rawText: "яку послугу", awaitingServiceConfirm: true },
      ),
    ).toEqual({});

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "named_procedure", serviceQuery: "ботокс" },
        { rawText: "ботокс", awaitingServiceConfirm: true },
      ),
    ).toEqual({});

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "decline_pending_service" },
        { rawText: "Обрати іншу процедуру", awaitingServiceConfirm: true },
      ).serviceIntent,
    ).toEqual({ kind: "decline_pending_service" });
  });
});

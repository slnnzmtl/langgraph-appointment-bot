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

  it("maps book this one to book_highlighted only when FAQ highlight is open", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "book this one",
        faqHighlightOpen: true,
      }),
    ).toEqual({ serviceIntent: { kind: "book_highlighted" } });

    expect(
      interpretBookingTurnDeterministic({
        rawText: "book this one",
      }),
    ).toEqual({});

    expect(
      interpretBookingTurnDeterministic({
        rawText: "Записатись",
        faqHighlightOpen: true,
      }),
    ).toEqual({ serviceIntent: { kind: "book_highlighted" } });

    expect(
      interpretBookingTurnDeterministic({
        rawText: "Записатись",
      }),
    ).toEqual({ serviceIntent: { kind: "consultation" } });
  });

  it("keeps consultation and yes separate from book_highlighted on FAQ highlight", () => {
    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "consultation" },
        { rawText: "I want a consultation", faqHighlightOpen: true },
      ).serviceIntent,
    ).toEqual({ kind: "consultation" });

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "confirm_pending_service" },
        { rawText: "yes", faqHighlightOpen: true },
      ).serviceIntent,
    ).toBeUndefined();

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "confirm_pending_service" },
        {
          rawText: "Так",
          faqHighlightOpen: true,
          awaitingServiceConfirm: true,
        },
      ).serviceIntent,
    ).toEqual({ kind: "confirm_pending_service" });

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "book_highlighted" },
        { rawText: "book this one", faqHighlightOpen: true },
      ).serviceIntent,
    ).toEqual({ kind: "book_highlighted" });

    expect(
      normalizeBookingTurnClassification(
        { serviceIntentKind: "book_highlighted" },
        { rawText: "book this one", faqHighlightOpen: false },
      ).serviceIntent,
    ).toBeUndefined();
  });

  it("rejects unoffered accept callback even while awaitingServiceConfirm", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "",
        callbackChoiceId: "accept",
        awaitingServiceConfirm: true,
        offeredChoiceIds: [],
      }),
    ).toEqual({});

    expect(
      interpretBookingTurnDeterministic({
        rawText: "",
        callbackChoiceId: "offer_accept",
        awaitingServiceConfirm: true,
        offeredChoiceIds: [],
      }),
    ).toEqual({});
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


describe("original FAQ offer labels", () => {
  it.each(["Так", "Yes"])("accepts %s only against the current highlighted row", (rawText) => {
    expect(interpretBookingTurnDeterministic({ rawText, faqHighlightOpen: true }))
      .toEqual({ serviceIntent: { kind: "book_highlighted" } });
    expect(interpretBookingTurnDeterministic({ rawText }))
      .toEqual({});
  });

  it("chooses another procedure through FAQ browse, not HITL decline", () => {
    expect(interpretBookingTurnDeterministic({ rawText: "Обрати іншу процедуру", faqHighlightOpen: true }))
      .toEqual({ serviceIntent: { kind: "catalog_browse" } });
  });

  it("still rejects unoffered callbacks even with a FAQ offer open", () => {
    expect(interpretBookingTurnDeterministic({
      rawText: "Так", callbackChoiceId: "offer_accept", offeredChoiceIds: ["svc-1"], faqHighlightOpen: true,
    })).toEqual({});
  });
  it("accumulates names alongside an independently supplied phone on booking start", () => {
    const patch = normalizeBookingTurnClassification(
      {
        serviceIntentKind: "named_procedure",
        serviceQuery: "Botox",
        phoneNumber: "+380501112233",
        firstName: "Іван",
        lastName: "Петренко",
      },
      { rawText: "Book Botox, Ivan Petrenko, +380501112233" },
    );
    expect(patch.contactFacts).toEqual({
      phoneNumber: "+380501112233",
      firstName: "Іван",
      lastName: "Петренко",
    });
  });

});

import { describe, expect, it } from "vitest";

import { extractMessageTextContent, extractRawMessageText, extractReplyButtons, catalogChoiceButtonsFromText, isBookingOfferReply, replyButtonLabels, unescapeModelLineBreaks } from "../message-content.js";

describe("catalogChoiceButtonsFromText", () => {
  it("recovers procedure family labels from a catalog-choice reply", () => {
    expect(
      catalogChoiceButtonsFromText(
        "У напрямку дерматологічних послуг є:\n• видалення новоутворень\n• пілінги\n• мезотерапія\n\nЯка саме процедура вас цікавить?",
      ),
    ).toEqual(["видалення новоутворень", "пілінги", "мезотерапія"]);
  });

  it("recovers direction labels without description suffixes", () => {
    expect(
      catalogChoiceButtonsFromText(
        "Ось основні напрями:\n• Консультації та діагностика — …\n• Ін'єкційні процедури — …\n\nЯкий саме напрямок вас цікавить?",
      ),
    ).toEqual(["Консультації та діагностика", "Ін'єкційні процедури"]);
  });

  it("recovers zone and brand labels", () => {
    expect(
      catalogChoiceButtonsFromText(
        "Для ботулінотерапії є варіанти:\n• 1 зона\n• 2 зони\n\nЯкий варіант вам підходить?",
      ),
    ).toEqual(["1 зона", "2 зони"]);
    expect(
      catalogChoiceButtonsFromText(
        "Оберіть препарат:\n• Disport\n• Nabota\n• Botox\n\nЯкий препарат вас цікавить?",
      ),
    ).toEqual(["Disport", "Nabota", "Botox"]);
  });

  it("recovers when the question uses послуга", () => {
    expect(
      catalogChoiceButtonsFromText(
        "Ось доступні послуги:\n• Консультація дерматолога\n• Консультація косметолога\n\nЯка саме послуга вас цікавить?",
      ),
    ).toEqual(["Консультація дерматолога", "Консультація косметолога"]);
  });

  it("recovers numbered CRM-style list items", () => {
    expect(
      catalogChoiceButtonsFromText(
        "В ін'єкційних процедурах є:\n1. збільшення губ\n2. ботулінотерапія\n3) біоревіталізація\n\nЯка процедура вас цікавить?",
      ),
    ).toEqual(["збільшення губ", "ботулінотерапія", "біоревіталізація"]);
  });

  it("does not recover bullets from a consultation yes/no offer", () => {
    expect(
      catalogChoiceButtonsFromText(
        "У нашій клініці доступні такі напрями\n\n• Консультації та діагностика — …\n• Ін'єкційні процедури — …\n\nЗаписати вас на консультацію?",
      ),
    ).toEqual([]);
  });

  it("does not recover bullets from hours or location replies", () => {
    expect(
      catalogChoiceButtonsFromText(
        "Пн–Пт: 9:00–18:00\n• понеділок\n• вівторок\n\nКоли вам зручно прийти?",
      ),
    ).toEqual([]);
    expect(catalogChoiceButtonsFromText("Адреса: вул. Миколаївська 33.")).toEqual([]);
  });
});

describe("isBookingOfferReply", () => {
  it("detects consultation and book-this-procedure yes/no questions", () => {
    expect(isBookingOfferReply("Підібрати вільний час на консультацію?")).toBe(true);
    expect(isBookingOfferReply("Записати вас на консультацію?")).toBe(true);
    expect(isBookingOfferReply("Бажаєте записатися на цю процедуру?")).toBe(true);
    expect(isBookingOfferReply("Для першого візиту радимо консультацію.\n\nПідібрати час?")).toBe(true);
    expect(isBookingOfferReply("Would you like to book a consultation?")).toBe(true);
  });

  it("does not treat catalog, date, or replace questions as booking offers", () => {
    expect(isBookingOfferReply("Який саме напрямок вас цікавить?")).toBe(false);
    expect(isBookingOfferReply("Який день вам зручний?")).toBe(false);
    expect(
      isBookingOfferReply("Бажаєте скасувати поточний візит і записати нову?"),
    ).toBe(false);
    expect(isBookingOfferReply("Адреса: вул. Миколаївська 33.")).toBe(false);
  });
});

describe("extractReplyButtons yield trailer", () => {
  it("strips yield tag and sets yieldToSupervisor", () => {
    const result = extractReplyButtons(
      "Записати вас на консультацію?\n<yield_to_supervisor/>\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
    );
    expect(result.text).toBe("Записати вас на консультацію?");
    expect(result.buttons).toEqual(["Так", "Обрати іншу процедуру"]);
    expect(result.yieldToSupervisor).toBe(true);
    expect(result.text).not.toContain("yield_to_supervisor");
  });

  it("handles yield-only trailer", () => {
    const result = extractReplyButtons("Done.\n<yield_to_supervisor/>");
    expect(result).toEqual({ text: "Done.", buttons: [], yieldToSupervisor: true });
  });

  it("defaults yieldToSupervisor to false when tag is absent", () => {
    const result = extractReplyButtons("Just text");
    expect(result.yieldToSupervisor).toBe(false);
  });
});

describe("replyButtonLabels", () => {
  it("returns stored lastHandoff labels", () => {
    expect(replyButtonLabels(["Записатись", "Послуги"])).toEqual(["Записатись", "Послуги"]);
  });

  it("does not parse a message trailer for markup", () => {
    expect(replyButtonLabels(undefined)).toEqual([]);
    expect(replyButtonLabels([])).toEqual([]);
  });
});

describe("extractRawMessageText", () => {
  it("does not decode JSON escaped newlines", () => {
    const json = JSON.stringify({ description: "a\nb" });
    expect(extractRawMessageText(json)).toBe(json);
    expect(JSON.parse(extractRawMessageText(json))).toEqual({ description: "a\nb" });
    expect(() => JSON.parse(extractMessageTextContent(json))).toThrow();
  });
});

describe("unescapeModelLineBreaks", () => {
  it("leaves real newlines alone", () => {
    expect(unescapeModelLineBreaks("a\n\nb")).toBe("a\n\nb");
  });

  it("decodes slash-n sequences", () => {
    expect(unescapeModelLineBreaks("a\\n\\nb")).toBe("a\n\nb");
  });
});

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { CLINIC_ADDRESS } from "../clinic-constants.js";
import {
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
  catalogChoiceButtonsFromText,
  isBookingOfferQuestion,
  isConsultationOfferQuestion,
  isYesReply,
  parseLeakedModelToolCalls,
  patientAgreedToConsultation,
  replyButtonLabels,
  requestsConsultation,
  unescapeModelLineBreaks,
} from "../message-content.js";

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
    expect(catalogChoiceButtonsFromText(`Адреса: ${CLINIC_ADDRESS}.`)).toEqual([]);
  });
});

describe("isBookingOfferQuestion", () => {
  it("detects consultation and book-this-procedure yes/no closers", () => {
    expect(isBookingOfferQuestion("Підібрати вільний час на консультацію?")).toBe(true);
    expect(
      isBookingOfferQuestion(
        "Для першого візиту радимо консультацію.\n\nПідібрати вільний час на консультацію?",
      ),
    ).toBe(true);
    expect(isBookingOfferQuestion("Записати вас на консультацію?")).toBe(true);
    expect(isBookingOfferQuestion("Бажаєте записатися на цю процедуру?")).toBe(true);
    expect(isBookingOfferQuestion("Для першого візиту радимо консультацію.\n\nПідібрати час?")).toBe(true);
    expect(isBookingOfferQuestion("Shall I book a consultation?")).toBe(true);
    expect(isBookingOfferQuestion("Would you like to book a consultation?")).toBe(true);
  });

  it("rejects phone, catalog, date, and cancel-rebook questions", () => {
    expect(isBookingOfferQuestion("Could you please provide your phone number?")).toBe(false);
    expect(isBookingOfferQuestion("Яка саме процедура вас цікавить?")).toBe(false);
    expect(isBookingOfferQuestion("Який саме напрямок вас цікавить?")).toBe(false);
    expect(isBookingOfferQuestion("Який день вам зручний?")).toBe(false);
    expect(isBookingOfferQuestion("Чи бажаєте підібрати новий час для запису?")).toBe(false);
    expect(isBookingOfferQuestion("Бажаєте скасувати поточний візит і записати нову?")).toBe(false);
    expect(isBookingOfferQuestion("Готово! Чекаємо вас на консультацію.")).toBe(false);
    expect(isBookingOfferQuestion(`Адреса: ${CLINIC_ADDRESS}.`)).toBe(false);
  });
});

describe("isConsultationOfferQuestion", () => {
  it("detects consultation offers only", () => {
    expect(isConsultationOfferQuestion("Підібрати вільний час на консультацію?")).toBe(true);
    expect(isConsultationOfferQuestion("Бажаєте записатися на цю процедуру?")).toBe(false);
  });
});

describe("isYesReply / requestsConsultation", () => {
  it("detects yes replies", () => {
    expect(isYesReply("Так")).toBe(true);
    expect(isYesReply("yes")).toBe(true);
    expect(isYesReply("запиши")).toBe(false);
  });

  it("detects consultation book requests, not topic questions or declines", () => {
    expect(requestsConsultation("запиши на консультацію")).toBe(true);
    expect(requestsConsultation("консультація")).toBe(true);
    expect(requestsConsultation("чи є у вас консультація?")).toBe(false);
    expect(requestsConsultation("не хочу консультацію")).toBe(false);
    expect(requestsConsultation("запиши на ботокс")).toBe(false);
  });
});

describe("patientAgreedToConsultation", () => {
  it("is true after Так to a consultation offer", () => {
    expect(
      patientAgreedToConsultation([
        new AIMessage("Підібрати вільний час на консультацію?"),
        new HumanMessage("Так"),
      ]),
    ).toBe(true);
  });

  it("is true when they name consultation", () => {
    expect(
      patientAgreedToConsultation([new HumanMessage("запиши на консультацію")]),
    ).toBe(true);
  });

  it("is false when they name another procedure after a consultation offer", () => {
    expect(
      patientAgreedToConsultation([
        new AIMessage("Підібрати вільний час на консультацію?"),
        new HumanMessage("запиши на ботулінотерапію"),
      ]),
    ).toBe(false);
  });

  it("is false when a topic question about consultation precedes another procedure", () => {
    expect(
      patientAgreedToConsultation([
        new HumanMessage("чи є у вас консультація?"),
        new AIMessage("Так, консультація доступна."),
        new HumanMessage("запиши на ботокс"),
      ]),
    ).toBe(false);
  });

  it("is false on an explicit decline", () => {
    expect(
      patientAgreedToConsultation([new HumanMessage("не хочу консультацію")]),
    ).toBe(false);
  });

  it("is cleared when they later book another procedure", () => {
    expect(
      patientAgreedToConsultation([
        new AIMessage("Підібрати вільний час на консультацію?"),
        new HumanMessage("Так"),
        new HumanMessage("запиши на ліполітики"),
      ]),
    ).toBe(false);
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

  it("strips leaked Gemini tool XML so it never reaches Telegram", () => {
    const result = extractReplyButtons(
      "<call:default_api:present_availability_slots{afterDate: 2026-09-29,durationMinutes:30}></call:default_api:present_availability_slots>",
    );
    expect(result.text).toBe("");
    expect(result.text).not.toContain("call:default_api");
    expect(result.buttons).toEqual([]);
  });
});

describe("parseLeakedModelToolCalls", () => {
  it("parses Gemini default_api XML with unquoted keys", () => {
    expect(
      parseLeakedModelToolCalls(
        "<call:default_api:present_availability_slots{afterDate: 2026-09-29,durationMinutes:30}></call:default_api:present_availability_slots>",
      ),
    ).toEqual([
      {
        name: "present_availability_slots",
        args: { afterDate: "2026-09-29", durationMinutes: 30 },
      },
    ]);
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

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  extractFaqCatalogAction,
  extractMessageTextContent,
  extractRawMessageText,
  extractReplyButtons,
  isConfirmationAffirmation,
  isConfirmationDecline,
  isYesReply,
  matchesReplyLabel,
  parseLeakedModelToolCalls,
  replyButtonLabels,
  requestsConsultation,
  unescapeModelLineBreaks,
} from "../message-content.js";

describe("matchesReplyLabel", () => {
  it("matches menu chips case-insensitively after trimming", () => {
    expect(matchesReplyLabel("послуги", ["Послуги", "Services"])).toBe(true);
    expect(matchesReplyLabel("  Services  ", ["Послуги", "Services"])).toBe(true);
    expect(matchesReplyLabel("адреса", ["Послуги", "Services"])).toBe(false);
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
    // Mixed note-step utterances still match — prepare must skip this when orch owns.
    expect(requestsConsultation("потрібна консультація щодо ювідерм")).toBe(true);
    expect(requestsConsultation("потрібна консультація щодо збільшення губ")).toBe(true);
  });
});

describe("free-text mutation confirmation", () => {
  it.each([
    "Так",
    "Так!",
    "Так, підтверджую!",
    "Yes please",
    "I confirm",
    "Подтверждаю",
    "👍",
  ])("accepts an explicit affirmation: %s", (reply) => {
    expect(isConfirmationAffirmation(reply)).toBe(true);
    expect(isConfirmationDecline(reply)).toBe(false);
  });

  it.each([
    "Ні",
    "Ні, дякую",
    "Не підтверджую",
    "Ні, не скасовуйте",
    "No thanks",
    "Don't confirm",
  ])("accepts an explicit decline: %s", (reply) => {
    expect(isConfirmationDecline(reply)).toBe(true);
    expect(isConfirmationAffirmation(reply)).toBe(false);
  });

  it.each(["А можна інший час?", "Яка адреса?", "No problem"])(
    "leaves another request unresolved: %s",
    (reply) => {
      expect(isConfirmationAffirmation(reply)).toBe(false);
      expect(isConfirmationDecline(reply)).toBe(false);
    },
  );

  it.each([
    ["Запишіть", "create"],
    ["Move it", "reschedule"],
    ["Скасуйте", "cancel"],
  ] as const)("accepts an action-specific affirmation: %s", (reply, action) => {
    expect(isConfirmationAffirmation(reply, action)).toBe(true);
  });
});

describe("extractFaqCatalogAction", () => {
  it.each([
    "keep_catalog",
    "offer_consultation",
    "close_catalog",
  ] as const)("extracts paired body tag %s and strips it from visible text", (action) => {
    expect(
      extractFaqCatalogAction(`Видимий текст.\n<faq_catalog_action>${action}</faq_catalog_action>`),
    ).toEqual({
      text: "Видимий текст.",
      action,
    });
  });

  it.each([
    "keep_catalog",
    "offer_consultation",
    "close_catalog",
  ] as const)("extracts self-closing attribute tag %s", (action) => {
    expect(
      extractFaqCatalogAction(
        `Видимий текст.\n<faq_catalog_action action="${action}"/>`,
      ),
    ).toEqual({
      text: "Видимий текст.",
      action,
    });
  });

  it("accepts single quotes and surrounding whitespace on the attribute", () => {
    expect(
      extractFaqCatalogAction(
        `Текст.\n<faq_catalog_action   action='keep_catalog'  />`,
      ),
    ).toEqual({ text: "Текст.", action: "keep_catalog" });
  });

  it("returns null action when the tag is missing", () => {
    expect(
      extractFaqCatalogAction("• Консультації та діагностика\n\nЯкий варіант вам підходить?"),
    ).toEqual({
      text: "• Консультації та діагностика\n\nЯкий варіант вам підходить?",
      action: null,
    });
  });

  it("strips invalid tags and returns null action", () => {
    expect(
      extractFaqCatalogAction(
        "Текст.\n<faq_catalog_action>maybe_consult</faq_catalog_action>",
      ),
    ).toEqual({
      text: "Текст.",
      action: null,
    });
    expect(
      extractFaqCatalogAction(
        'Текст.\n<faq_catalog_action action="not_a_real_action"/>',
      ),
    ).toEqual({
      text: "Текст.",
      action: null,
    });
  });

  it("accepts case-insensitive enum values", () => {
    expect(
      extractFaqCatalogAction(
        "Текст.\n<faq_catalog_action>KEEP_CATALOG</faq_catalog_action>",
      ),
    ).toEqual({
      text: "Текст.",
      action: "keep_catalog",
    });
  });

  it("returns null action for duplicate or conflicting valid tags", () => {
    expect(
      extractFaqCatalogAction(
        [
          "Текст.",
          "<faq_catalog_action>keep_catalog</faq_catalog_action>",
          '<faq_catalog_action action="keep_catalog"/>',
        ].join("\n"),
      ),
    ).toEqual({ text: "Текст.", action: null });
    expect(
      extractFaqCatalogAction(
        [
          "Текст.",
          "<faq_catalog_action>keep_catalog</faq_catalog_action>",
          '<faq_catalog_action action="close_catalog"/>',
        ].join("\n"),
      ),
    ).toEqual({ text: "Текст.", action: null });
  });

  it("leaves no faq_catalog_action substring after stripping malformed tags", () => {
    const result = extractFaqCatalogAction(
      'Текст.\n<faq_catalog_action action="keep_catalog"/><faq_catalog_action>broken',
    );
    expect(result.text).not.toContain("faq_catalog_action");
    expect(result.text).toContain("Текст.");
    expect(result.action).toBe("keep_catalog");
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

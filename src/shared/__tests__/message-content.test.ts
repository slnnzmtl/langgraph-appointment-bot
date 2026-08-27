import { describe, expect, it } from "vitest";

import { extractMessageTextContent, extractRawMessageText, extractReplyButtons, replyButtonLabels, unescapeModelLineBreaks } from "../message-content.js";

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
  it("prefers stored labels over a message trailer", () => {
    expect(
      replyButtonLabels(
        ["Записатись", "Послуги"],
        "Hi\n<reply_buttons>\nIgnored\n</reply_buttons>",
      ),
    ).toEqual(["Записатись", "Послуги"]);
  });

  it("falls back to parsing the trailer when stored labels are missing", () => {
    expect(
      replyButtonLabels(undefined, "Pick?\n<reply_buttons>\n25 серпня\nІнша дата\n</reply_buttons>"),
    ).toEqual(["25 серпня", "Інша дата"]);
  });

  it("returns an empty list when neither source has buttons", () => {
    expect(replyButtonLabels(undefined, "Just text")).toEqual([]);
    expect(replyButtonLabels([], "Just text")).toEqual([]);
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

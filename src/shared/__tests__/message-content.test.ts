import { describe, expect, it } from "vitest";

import { extractMessageTextContent, extractRawMessageText, extractReplyButtons, replyButtonLabels, unescapeModelLineBreaks } from "../message-content.js";

describe("extractReplyButtons", () => {
  it("strips a reply_buttons trailer and returns text plus labels", () => {
    const result = extractReplyButtons(
      "Записати вас на консультацію?\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
    );
    expect(result).toEqual({
      text: "Записати вас на консультацію?",
      buttons: ["Так", "Обрати іншу процедуру"],
    });
  });

  it("returns empty buttons when there is no trailer", () => {
    expect(extractReplyButtons("Just text")).toEqual({ text: "Just text", buttons: [] });
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

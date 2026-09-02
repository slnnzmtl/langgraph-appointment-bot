import { describe, expect, it } from "vitest";

import {
  buildConfirmKeyboard,
  buildDefaultMenuKeyboard,
  buildReplyKeyboard,
  classifyConfirmReply,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  MAIN_MENU_LABEL,
  extractReplyButtons,
  formatForTelegram,
  withMainMenu,
} from "../telegram-ui.js";

describe("telegram-ui confirm reply keyboard", () => {
  it("builds HITL confirm as a one-time reply keyboard with Головне меню", () => {
    const keyboard = buildConfirmKeyboard();
    expect(keyboard.keyboard).toEqual([
      [{ text: CONFIRM_YES_LABEL }, { text: CONFIRM_NO_LABEL }],
      [{ text: MAIN_MENU_LABEL }],
    ]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.one_time_keyboard).toBe(true);
  });

  it("classifies confirm taps vs free chat text", () => {
    expect(classifyConfirmReply("✅")).toEqual({ kind: "confirmed" });
    expect(classifyConfirmReply("❌")).toEqual({ kind: "declined" });
    expect(classifyConfirmReply(MAIN_MENU_LABEL)).toEqual({ kind: "declined" });
    expect(classifyConfirmReply("так")).toEqual({ kind: "chat" });
    expect(classifyConfirmReply("ні")).toEqual({ kind: "chat" });
    expect(classifyConfirmReply("✅\uFE0F")).toEqual({ kind: "confirmed" });
    expect(classifyConfirmReply("❌\uFE0F")).toEqual({ kind: "declined" });
  });
});

describe("extractReplyButtons", () => {
  it("strips a trailing reply_buttons block and returns unique labels", () => {
    const result = extractReplyButtons(
      "Підібрати вільний час на консультацію?\n\n<reply_buttons>\nТак\nОбрати іншу процедуру\nТак\n</reply_buttons>",
    );
    expect(result.text).toBe("Підібрати вільний час на консультацію?");
    expect(result.buttons).toEqual(["Так", "Обрати іншу процедуру"]);
    expect(result.yieldToSupervisor).toBe(false);
  });

  it("caps at six labels and ignores empty lines", () => {
    const result = extractReplyButtons(
      "Чим можу допомогти?\n<reply_buttons>\n\nA\nB\nC\nD\nE\nF\nG\n\n</reply_buttons>\n",
    );
    expect(result.text).toBe("Чим можу допомогти?");
    expect(result.buttons).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("returns no buttons when the block is missing or empty", () => {
    expect(extractReplyButtons("Just text")).toEqual({ text: "Just text", buttons: [], yieldToSupervisor: false });
    expect(extractReplyButtons("Ask?\n<reply_buttons>\n\n</reply_buttons>")).toEqual({
      text: "Ask?",
      buttons: [],
      yieldToSupervisor: false,
    });
    expect(extractReplyButtons("Ask?\n<reply_buttons>broken")).toEqual({
      text: "Ask?",
      buttons: ["broken"],
      yieldToSupervisor: false,
    });
  });

  it("splits jammed or repeated reply_buttons tags into separate labels", () => {
    const jammed = extractReplyButtons(
      "Чим можу допомогти?\n\n<reply_buttons>\nРозповісти про послуги</reply_buttons><reply_buttons>Запланувати візит\n</reply_buttons>",
    );
    expect(jammed.text).toBe("Чим можу допомогти?");
    expect(jammed.buttons).toEqual(["Розповісти про послуги", "Запланувати візит"]);

    const doubled = extractReplyButtons(
      "Hi\n<reply_buttons>\nA\n</reply_buttons>\n<reply_buttons>\nB\n</reply_buttons>",
    );
    expect(doubled.text).toBe("Hi");
    expect(doubled.buttons).toEqual(["A", "B"]);
  });

  it("keeps prose after the last closing tag in the visible text", () => {
    const result = extractReplyButtons(
      "Який день вам зручний?\n\n<reply_buttons>\n25 серпня\nІнша дата\n</reply_buttons>\n\nМожу також підказати адресу.",
    );
    expect(result.text).toBe(
      "Який день вам зручний?\n\nМожу також підказати адресу.",
    );
    expect(result.buttons).toEqual(["25 серпня", "Інша дата"]);
  });

  it("builds rows of up to two labels", () => {
    expect(buildReplyKeyboard(["Так"]).keyboard).toEqual([[{ text: "Так" }]]);
    expect(buildReplyKeyboard(["Так", "Ні"]).keyboard).toEqual([
      [{ text: "Так" }, { text: "Ні" }],
    ]);
    expect(buildReplyKeyboard(["A", "B", "C"]).keyboard).toEqual([
      [{ text: "A" }, { text: "B" }],
      [{ text: "C" }],
    ]);
    expect(buildReplyKeyboard(["A", "B", "C", "Інша дата"]).keyboard).toEqual([
      [{ text: "A" }, { text: "B" }],
      [{ text: "C" }, { text: "Інша дата" }],
    ]);
    expect(buildReplyKeyboard(["A", "B", "C", "Інша дата", MAIN_MENU_LABEL]).keyboard).toEqual([
      [{ text: "A" }, { text: "B" }],
      [{ text: "C" }, { text: "Інша дата" }],
      [{ text: MAIN_MENU_LABEL }],
    ]);
    expect(withMainMenu(["A", "B"])).toEqual(["A", "B", MAIN_MENU_LABEL]);
    expect(withMainMenu(["A", MAIN_MENU_LABEL])).toEqual(["A", MAIN_MENU_LABEL]);
    expect(buildDefaultMenuKeyboard(false).keyboard).toEqual([
      [{ text: "Записатись" }, { text: "Послуги" }],
      [{ text: "Адреса" }, { text: MAIN_MENU_LABEL }],
    ]);
    expect(buildDefaultMenuKeyboard(true).keyboard).toEqual([
      [{ text: "Мій запис" }, { text: "Послуги" }],
      [{ text: "Адреса" }, { text: MAIN_MENU_LABEL }],
    ]);
  });
});

describe("formatForTelegram", () => {
  it("converts Markdown bold to HTML bold", () => {
    expect(formatForTelegram("Say **hello** there")).toBe("Say <b>hello</b> there");
  });

  it("converts line-start * and - bullets to Unicode bullets", () => {
    expect(formatForTelegram("* first\n- second")).toBe("• first\n• second");
  });

  it("escapes HTML entities before inserting tags", () => {
    expect(formatForTelegram("A <tag> & **safe**")).toBe("A &lt;tag&gt; &amp; <b>safe</b>");
  });

  it("leaves mid-line asterisks unchanged", () => {
    expect(formatForTelegram("rate * 2")).toBe("rate * 2");
  });

  it("converts Markdown links to Telegram HTML anchors", () => {
    expect(
      formatForTelegram(
        "[Google maps](https://www.google.com/maps/place/Mukolayivska+St,+33,+Bilhorod-Dnistrovs'kyi,+Odes'ka+oblast,+Ukraine,+67701)",
      ),
    ).toBe(
      '<a href="https://www.google.com/maps/place/Mukolayivska+St,+33,+Bilhorod-Dnistrovs\'kyi,+Odes\'ka+oblast,+Ukraine,+67701">Google maps</a>',
    );
  });

  it("turns Gemini slash-n sequences and br tags into real paragraphs", () => {
    expect(formatForTelegram("Готово!\\n\\nвул. Миколаївська 33")).toBe(
      "Готово!\n\nвул. Миколаївська 33",
    );
    expect(formatForTelegram("Рядок 1<br><br>Рядок 2")).toBe("Рядок 1\n\nРядок 2");
  });
});

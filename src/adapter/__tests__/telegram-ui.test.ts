import { describe, expect, it } from "vitest";

import {
  buildConfirmKeyboard,
  decodeCallbackData,
  formatForTelegram,
} from "../telegram-ui.js";

describe("telegram-ui callback_data", () => {
  it("decodes confirm yes/no and treats other payloads as unknown", () => {
    expect(decodeCallbackData("confirm:yes")).toEqual({ kind: "confirm", confirmed: true });
    expect(decodeCallbackData("confirm:no")).toEqual({ kind: "confirm", confirmed: false });
    expect(decodeCallbackData("slot:2026-08-10T09:00:00|2026-08-10T09:30:00|09:00")).toEqual({
      kind: "unknown",
    });
  });

  it("builds the HITL confirm keyboard", () => {
    expect(buildConfirmKeyboard().inline_keyboard[0]).toHaveLength(2);
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

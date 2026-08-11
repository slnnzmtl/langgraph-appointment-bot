import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { formatForTelegram, interpretInvokeResult } from "../telegram-bot.js";
import { loadWelcomeMessage } from "../welcome-message.js";

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
});

describe("welcome message", () => {
  const crmHours = JSON.stringify({
    calendars: [
      {
        timeRanges: [["11:00", "15:00"]],
        weekdays: {
          "0": false,
          "1": true,
          "2": true,
          "3": true,
          "4": true,
          "5": true,
          "6": false,
        },
      },
    ],
  });

  const loadWithHours = (hoursJson: string) =>
    loadWelcomeMessage(async () => JSON.parse(hoursJson) as unknown, "user-1");

  it("includes intro, categorized services, and CRM hours without prices", async () => {
    const message = await loadWithHours(crmHours);
    expect(message).toContain("Welcome to **Clinic**.");
    expect(message).toContain("**Consultations**");
    expect(message).toContain("Консультація");
    expect(message).toContain("**Injectables**");
    expect(message).toContain("Біоревіталізація");
    expect(message).toContain("**Skin care**");
    expect(message).toContain("Пілінг");
    expect(message).toContain("Mon–Fri: 11:00–15:00");
    expect(message).toContain("Sat–Sun: closed");
    expect(message).not.toMatch(/UAH|USD|\$|грн/i);
  });

  it("formats CRM weekday-specific ranges", async () => {
    const message = await loadWithHours(
      JSON.stringify({
        calendars: [
          {
            timeRanges: [["09:00", "18:00"]],
            weekdays: {
              "0": false,
              "1": true,
              "2": true,
              "3": true,
              "4": true,
              "5": true,
              "6": false,
            },
            weekdayTimeRanges: {
              "5": [["09:00", "14:00"]],
            },
          },
        ],
      }),
    );
    expect(message).toContain("Mon–Thu: 09:00–18:00");
    expect(message).toContain("Fri: 09:00–14:00");
    expect(message).toContain("Sat–Sun: closed");
  });

  it("does not use clinic-constant fallback hours when CRM fails", async () => {
    expect((await loadWithHours(JSON.stringify({ error: "MCP down" }))).includes(
      "Currently unavailable.",
    )).toBe(true);
    expect((await loadWithHours("{}")).includes("Currently unavailable.")).toBe(true);
  });

  it("loadWelcomeMessage reads hours via get_working_time", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const message = await loadWelcomeMessage(async (name, args) => {
      calls.push({ name, args });
      return JSON.parse(crmHours) as unknown;
    }, "user-1");

    expect(calls).toEqual([{ name: "get_working_time", args: { userId: "user-1" } }]);
    expect(message).toContain("Mon–Fri: 11:00–15:00");
  });

  it("formats to Telegram HTML with bold headings and bullets", async () => {
    const html = formatForTelegram(await loadWithHours(crmHours));
    expect(html).toContain("<b>Clinic</b>");
    expect(html).toContain("<b>Consultations</b>");
    expect(html).toContain("• Консультація");
    expect(html).toContain("• Mon–Fri: 11:00–15:00");
    expect(html).not.toContain("*Consultations*");
  });
});

describe("interpretInvokeResult reply selection", () => {
  it("prefers the substantive specialist reply over routing leaks and short supervisor meta", () => {
    const result = interpretInvokeResult({
      messages: [
        new HumanMessage("show services"),
        new AIMessage(
          "Service A — 100 UAH\nService B — 200 UAH\nService C — 300 UAH with extra details",
        ),
        new AIMessage("I have provided the list above."),
        new AIMessage("next=FINISH"),
      ],
    });

    expect(result.text).toContain("Service A");
    expect(result.text).not.toBe("next=FINISH");
    expect(result.text).not.toBe("I have provided the list above.");
  });

  it("does not attach slot keyboard while text slot selection is enabled", () => {
    const result = interpretInvokeResult({
      messages: [
        new HumanMessage("ПОКАЖИ СЛОТИ"),
        new AIMessage("Available: 09:00, 09:30. Type a time."),
        new ToolMessage({
          tool_call_id: "slots-1",
          name: "present_availability_slots",
          content: JSON.stringify({
            slots: [
              {
                id: "2026-08-08T0900",
                label: "09:00",
                dateStart: "2026-08-08T09:00:00",
                dateEnd: "2026-08-08T09:30:00",
              },
            ],
          }),
        }),
      ],
    });

    expect(result.text).toContain("09:00");
    expect(result.reply_markup).toBeUndefined();
  });

  it("uses create_meeting confirmMessage from interrupt draft as the title", () => {
    const result = interpretInvokeResult({
      messages: [new HumanMessage("9:00 консультація")],
      __interrupt__: [
        {
          value: {
            type: "confirm_booking",
            draft: {
              name: "Консультація - Daniel",
              dateStart: "2026-08-07T09:00:00",
              dateEnd: "2026-08-07T09:30:00",
              confirmMessage: "Підтвердити запис?",
            },
          },
        },
      ],
    });

    expect(result.text).toBe(
      "Підтвердити запис?\nКонсультація - Daniel\n7 Aug 2026, 09:00–09:30",
    );
    expect(result.text).not.toContain("Confirm booking?");
    expect(result.reply_markup?.inline_keyboard.flat().map((b) => b.text)).toEqual([
      "✅",
      "❌",
    ]);
  });
});

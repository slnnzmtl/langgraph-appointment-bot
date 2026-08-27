import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { interpretInvokeResult } from "../telegram-outbound.js";
import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  MAIN_MENU_LABEL,
  VISIT_CHANGE_MENU,
  type ReplyKeyboardMarkup,
} from "../telegram-ui.js";

const asReply = (markup: unknown): ReplyKeyboardMarkup => markup as ReplyKeyboardMarkup;

describe("interpretInvokeResult reply selection", () => {
  it("prefers lastHandoff.replyText over a longer AI message in history", () => {
    const result = interpretInvokeResult({
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "Підкажіть ваш номер телефону.",
        replyButtons: undefined,
      },
      messages: [
        new HumanMessage("11:00"),
        new AIMessage(
          "Найближчі вільні дні для консультації 🗓️\n- 25 серпня\n- 3 вересня\n\nЯкий день вам зручний?",
        ),
        new AIMessage("Підкажіть ваш номер телефону."),
      ],
    });

    expect(result.text).toBe("Підкажіть ваш номер телефону.");
    expect(asReply(result.reply_markup).keyboard).toEqual([[{ text: MAIN_MENU_LABEL }]]);
  });

  it("falls back to longest visible AI text when lastHandoff has no replyText", () => {
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
    expect(result.text).not.toBe("I have provided the list above.");
  });

  it("uses lastHandoff.replyButtons when history no longer has a trailer", () => {
    const result = interpretInvokeResult({
      lastHandoff: {
        agentId: "FINISH",
        agentName: "supervisor",
        status: "ok",
        replyText: "Привіт, Тест! Я ШІ-асистент клініки.",
        replyButtons: ["Записатись", "Послуги", "Адреса"],
      },
      messages: [
        new HumanMessage("Головне меню"),
        new AIMessage("Привіт, Тест! Я ШІ-асистент клініки."),
      ],
    });

    expect(result.text).toBe("Привіт, Тест! Я ШІ-асистент клініки.");
    expect(asReply(result.reply_markup).keyboard).toEqual([
      [{ text: "Записатись" }, { text: "Послуги" }],
      [{ text: "Адреса" }, { text: MAIN_MENU_LABEL }],
    ]);
  });

  it("attaches date or time reply keyboards from lastHandoff", () => {
    const dates = interpretInvokeResult({
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyButtons: ["25 серпня", "3 вересня", "4 вересня", "Інша дата"],
      },
      messages: [
        new HumanMessage("коли можна"),
        new AIMessage("Який день вам зручний?"),
      ],
    });
    expect(dates.text).toBe("Який день вам зручний?");
    expect(asReply(dates.reply_markup).keyboard).toEqual([
      [{ text: "25 серпня" }, { text: "3 вересня" }],
      [{ text: "4 вересня" }, { text: "Інша дата" }],
      [{ text: MAIN_MENU_LABEL }],
    ]);

    const times = interpretInvokeResult({
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyButtons: ["11:00", "13:00"],
      },
      messages: [
        new HumanMessage("25 серпня"),
        new AIMessage("Який час вам зручний?"),
        new ToolMessage({
          tool_call_id: "slots-1",
          name: "present_availability_slots",
          content: JSON.stringify({
            slots: [
              {
                id: "2026-08-25T1100",
                label: "11:00",
                dateStart: "2026-08-25T11:00:00",
                dateEnd: "2026-08-25T11:30:00",
              },
            ],
          }),
        }),
      ],
    });
    expect(times.text).toBe("Який час вам зручний?");
    expect(asReply(times.reply_markup).keyboard).toEqual([
      [{ text: "11:00" }, { text: "13:00" }],
      [{ text: MAIN_MENU_LABEL }],
    ]);
    expect(asReply(times.reply_markup).one_time_keyboard).toBe(true);
  });

  it("keeps Головне меню when there are no other shortcuts", () => {
    const result = interpretInvokeResult({
      messages: [
        new HumanMessage("мій телефон"),
        new AIMessage("Підкажіть, будь ласка, ваш номер телефону."),
      ],
    });

    expect(result.text).toContain("номер телефону");
    expect(asReply(result.reply_markup).keyboard).toEqual([[{ text: MAIN_MENU_LABEL }]]);
  });

  it("renders visit-change shortcuts from lastHandoff after Мій запис", () => {
    const result = interpretInvokeResult({
      lastHandoff: {
        agentId: "FINISH",
        agentName: "supervisor",
        status: "ok",
        replyButtons: [...VISIT_CHANGE_MENU],
      },
      messages: [
        new HumanMessage("Мій запис"),
        new AIMessage(
          "Заплановані візити:\n🗓️ Видалення бородавки 1 шт - 3 вересня (четвер) о 11:00\n\nБажаєте перенести або скасувати цей візит?",
        ),
      ],
    });

    expect(result.text).toContain("Бажаєте перенести або скасувати");
    expect(asReply(result.reply_markup).keyboard).toEqual([
      [{ text: "Перенести" }, { text: "Скасувати" }],
      [{ text: "Ні, дякую" }, { text: MAIN_MENU_LABEL }],
    ]);
  });

  it("uses create_meeting confirmMessage and attaches ✅/❌ reply keyboard", () => {
    const result = interpretInvokeResult({
      messages: [
        new HumanMessage("9:00 консультація"),
        new AIMessage("Ignoring this text."),
      ],
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
      "Підтвердити запис?\n\nКонсультація - Daniel\n7 Aug 2026, 09:00–09:30",
    );
    expect(result.text).not.toContain("Confirm booking?");
    expect(asReply(result.reply_markup).keyboard).toEqual([
      [{ text: CONFIRM_YES_LABEL }, { text: CONFIRM_NO_LABEL }],
      [{ text: MAIN_MENU_LABEL }],
    ]);
    expect(asReply(result.reply_markup).one_time_keyboard).toBe(true);
  });
});

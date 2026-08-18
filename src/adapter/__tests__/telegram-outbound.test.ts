import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { interpretInvokeResult } from "../telegram-outbound.js";

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

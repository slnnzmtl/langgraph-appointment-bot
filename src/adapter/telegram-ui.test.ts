import { describe, expect, it } from "vitest";

import {
  buildConfirmKeyboard,
  buildSlotsKeyboard,
  decodeCallbackData,
  encodeSlotCallback,
  slotChoiceHumanText,
} from "./telegram-ui.js";

describe("telegram-ui callback_data", () => {
  it("round-trips slot encode/decode", () => {
    const slot = {
      id: "2026-08-10T0900",
      label: "09:00",
      dateStart: "2026-08-10T09:00:00",
      dateEnd: "2026-08-10T09:30:00",
    };
    const encoded = encodeSlotCallback(slot);
    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(decodeCallbackData(encoded)).toEqual({
      kind: "slot",
      dateStart: slot.dateStart,
      dateEnd: slot.dateEnd,
      label: slot.label,
    });
  });

  it("decodes confirm yes/no", () => {
    expect(decodeCallbackData("confirm:yes")).toEqual({ kind: "confirm", confirmed: true });
    expect(decodeCallbackData("confirm:no")).toEqual({ kind: "confirm", confirmed: false });
  });

  it("builds slot and confirm keyboards", () => {
    const slotsKb = buildSlotsKeyboard([
      {
        id: "a",
        label: "09:00",
        dateStart: "2026-08-10T09:00:00",
        dateEnd: "2026-08-10T09:30:00",
      },
    ]);
    expect(slotsKb.inline_keyboard[0]?.[0]).toMatchObject({ text: "09:00" });
    expect(buildConfirmKeyboard().inline_keyboard[0]).toHaveLength(2);
  });

  it("formats slot HumanMessage text", () => {
    expect(slotChoiceHumanText("2026-08-10T09:00:00", "2026-08-10T09:30:00", "09:00")).toContain(
      "09:00",
    );
  });
});

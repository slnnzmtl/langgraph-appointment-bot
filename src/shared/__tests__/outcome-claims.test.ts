import { describe, expect, it } from "vitest";

import { claimsOutcome } from "../outcome-claims.js";

describe("claimsOutcome", () => {
  it.each([
    ["Готово! Запис створено.", "gotovo"],
    ["Готово! Запис перенесено.", "gotovo"],
    ["Запис скасовано.", "skasovano"],
    ["Вас записано на консультацію.", "zapysano"],
    ["Бронювання підтверджено.", "pidtverdzheno"],
    ["You are booked for tomorrow.", "booked"],
    ["Visit rescheduled successfully.", "rescheduled"],
  ])("detects outcome claim: %s", (text, rule) => {
    expect(claimsOutcome(text)).toEqual({ rule });
  });

  it("ignores clearly negated outcome phrasing", () => {
    expect(claimsOutcome("Запис не було створено.")).toBeNull();
    expect(claimsOutcome("Nothing was booked.")).toBeNull();
  });

  it("does not treat address-only replies as outcome claims", () => {
    expect(
      claimsOutcome("Ми за адресою:\n\nвул. Прикладна 1, м. Київ\n[Google maps](https://example.com)"),
    ).toBeNull();
  });
});

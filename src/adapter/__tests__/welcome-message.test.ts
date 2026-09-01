import { describe, expect, it } from "vitest";

import { loadWelcomeMessage } from "../welcome-message.js";

describe("loadWelcomeMessage hours formatting", () => {
  const loadWithHours = (hoursJson: string) =>
    loadWelcomeMessage(async () => JSON.parse(hoursJson) as unknown, "user-1");

  it("groups consecutive weekdays and applies weekdayTimeRanges overrides", async () => {
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

    expect(message).toContain("**Години роботи**");
    expect(message).toContain("Понеділок–Четвер: 09:00–18:00");
    expect(message).toContain("П'ятниця: 09:00–14:00");
    expect(message).toContain("Субота–Неділя: вихідний");
    expect(message).toContain("Катерина Федченко");
    expect(message).toContain("вул. Миколаївська 33");
  });

  it("shows hours unavailable when CRM get_working_time fails or returns empty", async () => {
    expect(await loadWithHours(JSON.stringify({ error: "MCP down" }))).toContain(
      "Час роботи наразі недоступний.",
    );
    expect(await loadWithHours("{}")).toContain("Час роботи наразі недоступний.");
  });
});

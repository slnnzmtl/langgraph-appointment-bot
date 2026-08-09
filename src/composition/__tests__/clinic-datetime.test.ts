import { describe, expect, it } from "vitest";

import {
  formatKyivSystemMetadata,
  getKyivYmd,
  kyivCalendarDate,
} from "../clinic-datetime.js";

describe("clinic-datetime", () => {
  it("formats Kyiv calendar dates for a known UTC instant", () => {
    // 2026-08-07 22:30 UTC = 2026-08-08 01:30 Kyiv (UTC+3 in summer)
    const instant = new Date("2026-08-07T22:30:00.000Z");
    expect(kyivCalendarDate(instant, 0)).toBe("2026-08-08");
    expect(kyivCalendarDate(instant, 1)).toBe("2026-08-09");
    expect(getKyivYmd(instant)).toEqual({ year: 2026, month: 8, day: 8 });
  });

  it("includes TODAY and TOMORROW in system metadata", () => {
    const instant = new Date("2026-08-07T10:00:00.000Z");
    const block = formatKyivSystemMetadata(instant, { runtimeAgent: "Booking" });
    expect(block).toContain("Europe/Kyiv");
    expect(block).toContain(`TODAY: ${kyivCalendarDate(instant, 0)}`);
    expect(block).toContain(`TOMORROW: ${kyivCalendarDate(instant, 1)}`);
    expect(block).toContain("RUNTIME_AGENT: Booking");
  });
});

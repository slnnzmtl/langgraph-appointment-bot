import { afterEach, describe, expect, it, vi } from "vitest";

import { readModelsFromClinicState } from "../booking-decide-nodes.js";
import { clinicState } from "../../__tests__/agent-loop-fixtures.js";

const originalTimezone = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (originalTimezone == null) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

describe("booking clinic-day input", () => {
  it("uses Kyiv midnight even when the host timezone is different", () => {
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-10-23T20:59:59Z"));
    expect(readModelsFromClinicState(clinicState()).clinicDay).toBe("2026-10-23");

    vi.setSystemTime(new Date("2026-10-23T21:00:00Z"));
    expect(readModelsFromClinicState(clinicState()).clinicDay).toBe("2026-10-24");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enrichPatchWithReadModels,
  readModelsFromClinicState,
} from "../booking-decide-nodes.js";
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
  it("does not expose truncated checkpoint availability as verified slot evidence", () => {
    const state = clinicState({
      availabilityContext: {
        days: [{
          date: "2026-10-26",
          slots: [{
            id: "2026-10-26T11:00:00",
            label: "11:00",
            dateStart: "2026-10-26T11:00:00",
            dateEnd: "2026-10-26T11:30:00",
          }],
        }],
        stepMinutes: 30,
        startIntervalMinutes: 30,
        truncated: true,
        query: {
          kind: "later",
          rangeFrom: "2026-10-26",
          rangeThrough: "2026-11-24",
          coverageComplete: false,
        },
      },
    });
    const readModels = readModelsFromClinicState(state);

    expect(readModels.availabilityVerified).toBe(false);
    expect(readModels.availabilityDays).toBeUndefined();
    expect(readModels.availabilitySnapshotId).toBeUndefined();
    expect(enrichPatchWithReadModels(
      { choice: { choiceId: "2026-10-26T11:00:00" } },
      state,
      readModels,
    )).toEqual({ choice: { choiceId: "2026-10-26T11:00:00" } });
  });

  it("preserves verified Telegram ownership when the contact has no names", () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{ id: "contact-empty-names", phoneNumber: "+380501112233" }],
      },
    });
    expect(readModelsFromClinicState(state).ownedContact).toEqual({});
  });

  it("uses Kyiv midnight even when the host timezone is different", () => {
    process.env.TZ = "America/Los_Angeles";
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-10-23T20:59:59Z"));
    expect(readModelsFromClinicState(clinicState()).clinicDay).toBe("2026-10-23");

    vi.setSystemTime(new Date("2026-10-23T21:00:00Z"));
    expect(readModelsFromClinicState(clinicState()).clinicDay).toBe("2026-10-24");
  });
});

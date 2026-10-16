import { describe, expect, it } from "vitest";

import { createEmptyBookingDraft } from "../booking-draft.js";
import { classifyCancelTap } from "../supervisor/routing-predicates.js";
import { supervisorState } from "./supervisor-fixtures.js";

const CANCEL_CHIP = "Скасувати";

const legacySlot = {
  dateStart: "2026-10-17T11:00:00",
  dateEnd: "2026-10-17T11:30:00",
  label: "11:00",
};

describe("DDD-265 legacy checkpoint boundary", () => {
  it("classifyCancelTap ignores deprecated top-level selectedSlot", () => {
    const tap = classifyCancelTap(
      supervisorState({
        bookingDraft: null,
        selectedSlot: legacySlot,
      }),
      CANCEL_CHIP,
    );
    expect(tap).not.toBe("abandon");
  });

  it("classifyCancelTap abandons from bookingDraft without an authoritative slot", () => {
    const tap = classifyCancelTap(
      supervisorState({
        bookingDraft: createEmptyBookingDraft(),
        selectedSlot: legacySlot,
      }),
      CANCEL_CHIP,
    );
    expect(tap).toBe("abandon");
  });
});

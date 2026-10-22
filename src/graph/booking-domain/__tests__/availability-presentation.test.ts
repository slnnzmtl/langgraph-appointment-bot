import { describe, expect, it } from "vitest";

import {
  MAX_PROPOSED_AVAILABILITY_DAYS,
  OTHER_DATE_LABEL,
} from "../../../shared/clinic-constants.js";
import { projectAvailabilityPresentation } from "../availability-presentation.js";

const day = (
  date: string,
  slots: Array<{ id: string; label: string }>,
) => ({ date, dayLabel: date, slots });

describe("projectAvailabilityPresentation", () => {
  it("time_select includes every slot on the day plus other_date", () => {
    const slots = [
      { id: "s1", label: "10:00" },
      { id: "s2", label: "10:30" },
      { id: "s3", label: "11:00" },
      { id: "s4", label: "11:30" },
      { id: "s5", label: "12:00" },
    ];
    const projected = projectAvailabilityPresentation(
      [day("2026-09-10", slots)],
      { selectedDate: "2026-09-10", snapshotId: "snap" },
    );
    expect(projected?.mode).toBe("time_select");
    expect(projected?.choices.map((c) => c.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "other_date",
    ]);
    expect(projected?.choices.at(-1)?.label).toBe(OTHER_DATE_LABEL);
  });

  it("date_select caps open days at MAX_PROPOSED_AVAILABILITY_DAYS plus other_date", () => {
    const days = Array.from({ length: 5 }, (_, i) =>
      day(`2026-09-${10 + i}`, [{ id: `s${i}`, label: "10:00" }]),
    );
    const projected = projectAvailabilityPresentation(days, {
      snapshotId: "snap",
    });
    expect(projected?.mode).toBe("date_select");
    const ids = projected?.choices.map((c) => c.id) ?? [];
    expect(ids.filter((id) => id !== "other_date")).toHaveLength(
      MAX_PROPOSED_AVAILABILITY_DAYS,
    );
    expect(ids.at(-1)).toBe("other_date");
  });
});

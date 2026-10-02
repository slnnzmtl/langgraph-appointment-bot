import { describe, expect, it } from "vitest";

import {
  reconcileRequestedTime,
  resolveBookingScheduleRequest,
} from "../booking-schedule.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";

describe("booking schedule resolver", () => {
  it("resolves a day-only phrase with a preferred time", () => {
    expect(resolveBookingScheduleRequest("Перенеси мій запис на 16 число о 14:00", "2026-10-02")).toEqual({
      kind: "exact",
      date: "2026-10-16",
      preferredTime: "14:00",
    });
  });

  it("keeps a bare hour as a time when a selected date has available slots", () => {
    expect(resolveBookingScheduleRequest("14", "2026-10-02", {
      selectedDate: "2026-10-16",
      availabilityContext: {
        days: [{
          date: "2026-10-16",
          slots: [{
            id: "slot-1",
            dateStart: "2026-10-16T14:00:00",
            dateEnd: "2026-10-16T14:30:00",
            label: "14:00",
          }],
        }],
        stepMinutes: 30,
      },
    })).toBeNull();
  });
});

describe("requested-time reconciliation", () => {
  const target = { id: "meeting-1", name: "Консультація" };

  const draft = reduceBookingDraft(
    reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: target,
    }),
    {
      type: "schedule_requested",
      date: "2026-10-16",
      preferredTime: "14:00",
    },
  );

  it("matches the requested time only in an exact excluded-meeting snapshot", () => {
    expect(reconcileRequestedTime(draft, {
      days: [{
        date: "2026-10-16",
        slots: [{
          id: "slot-1",
          dateStart: "2026-10-16T14:00:00",
          dateEnd: "2026-10-16T14:30:00",
          label: "14:00",
        }],
      }],
      stepMinutes: 30,
      excludeMeetingIds: ["meeting-1"],
      query: { kind: "exact", date: "2026-10-16", coverageComplete: true },
    })).toMatchObject({ kind: "matched", slot: { slotId: "slot-1", dateStart: "2026-10-16T14:00:00" } });
  });

  it("does not match a nearest snapshot or silently substitute another time", () => {
    expect(reconcileRequestedTime(draft, {
      days: [{
        date: "2026-10-16",
        slots: [{
          id: "slot-2",
          dateStart: "2026-10-16T14:30:00",
          dateEnd: "2026-10-16T15:00:00",
          label: "14:30",
        }],
      }],
      stepMinutes: 30,
      excludeMeetingIds: ["meeting-1"],
      query: { kind: "nearest", coverageComplete: true },
    })).toEqual({ kind: "not_applicable" });
    expect(reconcileRequestedTime(draft, {
      days: [{ date: "2026-10-16", slots: [] }],
      stepMinutes: 30,
      excludeMeetingIds: ["meeting-1"],
      query: { kind: "exact", date: "2026-10-16", coverageComplete: true },
    })).toEqual({ kind: "unavailable", requestedTime: "14:00" });
  });
});

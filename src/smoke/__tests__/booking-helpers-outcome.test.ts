import { describe, expect, it, vi } from "vitest";

import { CANCEL_CONFIRMATION_UK } from "../../shared/clinic-constants.js";
import { SmokeAssertError } from "../assert.js";
import type { TurnResult } from "../harness.js";
import {
  assertBookingInterval,
  assertNoCommittedOutcomeBeforeConfirm,
  resolveCreatedMeetingId,
  RESCHEDULE_CONFIRM_PREFIX_UK,
} from "../scenarios/booking-helpers.js";

import type { CallRecord, ScenarioContext } from "../types.js";

const turn = (reply: string): TurnResult => ({
  reply,
  buttons: [],
  state: {
    pendingInteraction: null,
    bookingDraft: null,
    lastHandoff: null,
    contactContext: null,
    bookingContext: null,
    availabilityContext: null,
  },
  calls: [],
  pendingConfirm: false,
});

describe("assertNoCommittedOutcomeBeforeConfirm", () => {
  it("allows runtime cancel HITL caption", () => {
    expect(() =>
      assertNoCommittedOutcomeBeforeConfirm("cancel", turn(CANCEL_CONFIRMATION_UK)),
    ).not.toThrow();
  });

  it("allows runtime reschedule HITL caption", () => {
    expect(() =>
      assertNoCommittedOutcomeBeforeConfirm(
        "reschedule",
        turn(`${RESCHEDULE_CONFIRM_PREFIX_UK}12:00?\n\nКонсультація - Smoke Tester`),
      ),
    ).not.toThrow();
  });

  it("rejects committed cancel copy", () => {
    expect(() =>
      assertNoCommittedOutcomeBeforeConfirm("cancel", turn("Запис скасовано.")),
    ).toThrow(SmokeAssertError);
  });

  it("rejects committed success copy", () => {
    expect(() =>
      assertNoCommittedOutcomeBeforeConfirm(
        "reschedule",
        turn("Готово! Запис перенесено на 2026-10-16 о 12:00."),
      ),
    ).toThrow(SmokeAssertError);
  });

  it("rejects model-authored cancel confirm question", () => {
    expect(() =>
      assertNoCommittedOutcomeBeforeConfirm(
        "cancel",
        turn("Будь ласка, підтвердити скасування?"),
      ),
    ).toThrow(SmokeAssertError);
  });
});


describe("resolveCreatedMeetingId", () => {
  const context = () => ({
    callTool: vi.fn(async () => ({ list: [] })),
    cleanup: { trackMeeting: vi.fn(), trackContact: vi.fn(), run: vi.fn() },
  });

  it.each([
    { result: { error: "This meeting is outside working hours." } },
    { result: JSON.stringify({ error: "This meeting is outside working hours." }) },
    { result: { id: "not-a-commit", error: "This meeting is outside working hours." } },
    { error: "This meeting is outside working hours." },
  ])("preserves create rejection instead of looking up an unrelated visit: %j", async (failure) => {
    const ctx = context();
    const calls: CallRecord[] = [{ name: "create_meeting", args: {}, ...failure }];
    await expect(resolveCreatedMeetingId(ctx as unknown as ScenarioContext, "contact-1", calls))
      .rejects.toThrow("create_meeting failed: This meeting is outside working hours.");
    expect(ctx.callTool).not.toHaveBeenCalled();
    expect(ctx.cleanup.trackMeeting).not.toHaveBeenCalled();
  });

  it("tracks a successful create id without an extra lookup", async () => {
    const ctx = context();
    await expect(resolveCreatedMeetingId(ctx as unknown as ScenarioContext, "contact-1", [
      { name: "create_meeting", args: {}, result: { id: "meeting-1" } },
    ])).resolves.toBe("meeting-1");
    expect(ctx.cleanup.trackMeeting).toHaveBeenCalledWith("meeting-1");
    expect(ctx.callTool).not.toHaveBeenCalled();
  });

  it("retains the missing-Planned assertion when no error or id is available", async () => {
    const ctx = context();
    await expect(resolveCreatedMeetingId(ctx as unknown as ScenarioContext, "contact-1", []))
      .rejects.toThrow("expected a Planned meeting after confirm, found none");
  });
});

describe("assertBookingInterval", () => {
  const slot = { dateStart: "2026-10-26T11:00:00", dateEnd: "2026-10-26T12:00:00" };

  it("accepts the CRM space-separated representation of the exact selected interval", () => {
    expect(() => assertBookingInterval("stored", {
      dateStart: "2026-10-26 11:00:00", dateEnd: "2026-10-26 12:00:00",
    }, 60, slot)).not.toThrow();
  });

  it.each([
    { dateStart: slot.dateStart, dateEnd: "2026-10-26T11:30:00" },
    { dateStart: slot.dateStart, dateEnd: "2026-10-26T11:59:59" },
    { dateStart: slot.dateEnd, dateEnd: slot.dateStart },
    { dateStart: slot.dateStart, dateEnd: slot.dateStart },
    { dateStart: slot.dateStart },
    { dateStart: "not-a-date", dateEnd: slot.dateEnd },
  ])("rejects lost duration, rounding, invalid or incomplete intervals: %j", (interval) => {
    expect(() => assertBookingInterval("stored", interval, 60, slot)).toThrow(SmokeAssertError);
  });

  it("rejects a different interval even if its duration matches", () => {
    expect(() => assertBookingInterval("stored", {
      dateStart: "2026-10-26T11:30:00", dateEnd: "2026-10-26T12:30:00",
    }, 60, slot)).toThrow("interval differs from the selected slot");
  });
});

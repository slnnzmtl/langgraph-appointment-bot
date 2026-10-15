import { describe, expect, it } from "vitest";

import { CANCEL_CONFIRMATION_UK } from "../../shared/clinic-constants.js";
import { SmokeAssertError } from "../assert.js";
import type { TurnResult } from "../harness.js";
import {
  assertNoCommittedOutcomeBeforeConfirm,
  RESCHEDULE_CONFIRM_PREFIX_UK,
} from "../scenarios/booking-helpers.js";

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

import { describe, expect, it } from "vitest";

import { projectBookingView } from "../view.js";
import {
  interpretBookingTurnDeterministic,
  scheduleIntentFromChoice,
} from "../interpret.js";
import type { BookingSessionV2 } from "../session.js";

const session = (overrides: Partial<BookingSessionV2> = {}): BookingSessionV2 => ({
  schemaVersion: 2,
  revision: 1,
  mode: "create",
  serviceAcceptance: {
    status: "accepted",
    service: { id: "svc-1", name: "Botox", source: "catalog" },
  },
  selectedDate: null,
  selectedSlot: null,
  requestedTime: null,
  note: { status: "unasked" },
  contact: { contactId: null },
  rescheduleTarget: null,
  replacement: null,
  pendingDecision: null,
  pendingCommand: null,
  pendingEffect: null,
  ...overrides,
});

const reads = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: true,
};

describe("projectBookingView", () => {
  it("derives date_select when requirement is date", () => {
    const view = projectBookingView({
      session: session(),
      readModels: reads,
      availabilitySnapshotId: "snap-1",
      availabilityChoiceIds: ["date:2026-09-10"],
      locale: "uk",
    });
    expect(view.card).toEqual({
      kind: "date_select",
      snapshotId: "snap-1",
      choiceIds: ["date:2026-09-10"],
    });
  });

  it("renders EN mutation confirm from pendingDecision", () => {
    const view = projectBookingView({
      session: session({
        pendingDecision: {
          kind: "mutation_confirm",
          action: "create",
          effectId: "eff-1",
        },
        pendingCommand: { action: "create", payload: {} },
      }),
      readModels: reads,
      locale: "en",
    });
    expect(view.replyText).toBe("Confirm the booking?");
    expect(view.card).toEqual({
      kind: "mutation_confirm",
      action: "create",
      effectId: "eff-1",
    });
  });
});

describe("interpretBookingTurnDeterministic", () => {
  it("parses phone + date/time and control aliases", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Book me 2026-09-10 13:00, +380501112233",
      }),
    ).toMatchObject({
      scheduleIntent: { kind: "date_and_time", date: "2026-09-10", time: "13:00" },
      contactFacts: { phoneNumber: "+380501112233" },
    });
    expect(
      interpretBookingTurnDeterministic({ rawText: "Головне меню" }).controlIntent,
    ).toEqual({ kind: "main_menu" });
    expect(
      interpretBookingTurnDeterministic({ rawText: "❌" }).controlIntent,
    ).toEqual({ kind: "hitl_no" });
  });

  it("resolves ordinals only against current choices", () => {
    const choices = [
      { id: "date:2026-09-10", label: "10 вер" },
      { id: "date:2026-09-11", label: "11 вер" },
    ];
    expect(
      interpretBookingTurnDeterministic({ rawText: "2", choices }).choice,
    ).toEqual({ choiceId: "date:2026-09-11", label: "11 вер" });
    expect(
      interpretBookingTurnDeterministic({ rawText: "3", choices }).choice,
    ).toBeUndefined();
  });

  it("maps choice ids to schedule intents", () => {
    expect(scheduleIntentFromChoice("date:2026-09-10")).toEqual({
      kind: "date",
      date: "2026-09-10",
    });
  });

  it("treats hours questions as informational", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "Який у вас графік роботи?",
      }).informationalQuestion,
    ).toBeTruthy();
  });
});

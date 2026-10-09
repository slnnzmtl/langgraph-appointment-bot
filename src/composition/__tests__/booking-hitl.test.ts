import { describe, expect, it } from "vitest";

import { resumeConfirmBookingHitl } from "../booking-hitl.js";

const confirmingDraft = {
  version: 1,
  mode: "create" as const,
  phase: "confirming" as const,
  serviceAcceptance: {
    status: "accepted" as const,
    service: { id: "svc-1", name: "Процедура", source: "catalog" as const },
  },
  selectedDate: "2026-10-27",
  selectedSlot: {
    dateStart: "2026-10-27T11:00:00",
    dateEnd: "2026-10-27T11:30:00",
    label: "11:00",
  },
  requestedTime: null,
  note: { status: "skipped" as const },
  contactId: "c-1",
  pendingCommand: {
    action: "create" as const,
    payload: {
      serviceId: "svc-1",
      contactId: "c-1",
      dateStart: "2026-10-27T11:00:00",
      dateEnd: "2026-10-27T11:30:00",
    },
  },
  replacement: null,
};

const mutationConfirm = {
  kind: "mutation_confirm" as const,
  action: "create" as const,
  choices: [
    { id: "confirm", label: "✅" },
    { id: "decline", label: "❌" },
  ],
};

describe("resumeConfirmBookingHitl", () => {
  it("maps ✅ / ❌ / exact Головне меню to confirmed resume", () => {
    expect(
      resumeConfirmBookingHitl({
        text: "✅",
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
      }).resume,
    ).toEqual({ confirmed: true });

    const declined = resumeConfirmBookingHitl({
      text: "❌",
      bookingDraft: confirmingDraft,
      pendingInteraction: mutationConfirm,
    });
    expect(declined.resume).toEqual({ confirmed: false });
    expect(declined.update.pendingInteraction).toBeNull();
    expect(declined.update.bookingDraft).toMatchObject({
      selectedSlot: confirmingDraft.selectedSlot,
      pendingCommand: null,
    });

    const menu = resumeConfirmBookingHitl({
      text: "Головне меню",
      bookingDraft: confirmingDraft,
      pendingInteraction: mutationConfirm,
    });
    expect(menu.resume).toEqual({ confirmed: false });
    expect(menu.update.pendingInteraction).toBeNull();
  });

  it("declines typed main-menu variants without clearing the selected slot", () => {
    for (const text of ["головне меню", "MAIN MENU", "main menu"]) {
      const result = resumeConfirmBookingHitl({
        text,
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
        bookingUpdate: { bookingSchemaVersion: 1 },
      });
      expect(result.resume).toEqual({ confirmed: false });
      expect(result.update).toMatchObject({
        bookingSchemaVersion: 1,
        pendingInteraction: null,
        bookingDraft: {
          selectedDate: "2026-10-27",
          selectedSlot: confirmingDraft.selectedSlot,
          pendingCommand: null,
        },
      });
    }
  });

  it("dispatches mutation_chat_other for free text while mutation_confirm is open", () => {
    const result = resumeConfirmBookingHitl({
      text: "Яка адреса?",
      bookingDraft: confirmingDraft,
      pendingInteraction: mutationConfirm,
    });
    expect(result.resume).toEqual({ userReply: "Яка адреса?" });
    expect(result.update.pendingInteraction).toMatchObject({ kind: "mutation_confirm" });
    expect(result.update.bookingDraft).toMatchObject({
      selectedDate: "2026-10-27",
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("maps NL affirm / decline when mutation_confirm is open", () => {
    expect(
      resumeConfirmBookingHitl({
        text: "Так, підтверджую",
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
      }).resume,
    ).toEqual({ confirmed: true });

    expect(
      resumeConfirmBookingHitl({
        text: "Ні, не треба",
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
      }).resume,
    ).toEqual({ confirmed: false });
  });
});

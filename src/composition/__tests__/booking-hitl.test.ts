import { HumanMessage } from "@langchain/core/messages";
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
  it("maps ✅ / ❌ to confirmed resume without session patching", () => {
    expect(
      resumeConfirmBookingHitl({
        text: "✅",
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
      }),
    ).toEqual({
      resume: { confirmed: true },
      update: {},
    });

    const declined = resumeConfirmBookingHitl({
      text: "❌",
      bookingDraft: confirmingDraft,
      pendingInteraction: mutationConfirm,
      bookingUpdate: { bookingSchemaVersion: 1 },
    });
    expect(declined.resume).toEqual({ confirmed: false });
    expect(declined.update).toEqual({ bookingSchemaVersion: 1 });
  });

  it("maps Головне меню and typed variants to left with a HumanMessage", () => {
    for (const text of ["Головне меню", "головне меню", "MAIN MENU", "main menu"]) {
      const result = resumeConfirmBookingHitl({
        text,
        bookingDraft: confirmingDraft,
        pendingInteraction: mutationConfirm,
        bookingUpdate: { bookingSchemaVersion: 1 },
      });
      expect(result.resume).toEqual({ left: true });
      expect(result.update.bookingSchemaVersion).toBe(1);
      expect(result.update.bookingDraft).toBeUndefined();
      expect(result.update.pendingInteraction).toBeUndefined();
      expect(result.update.messages).toEqual([new HumanMessage(text)]);
    }
  });

  it("resumes free text as userReply with a HumanMessage while mutation_confirm is open", () => {
    const result = resumeConfirmBookingHitl({
      text: "Яка адреса?",
      bookingDraft: confirmingDraft,
      pendingInteraction: mutationConfirm,
      bookingUpdate: { bookingSchemaVersion: 1 },
    });
    expect(result.resume).toEqual({ userReply: "Яка адреса?" });
    expect(result.update.bookingSchemaVersion).toBe(1);
    expect(result.update.bookingDraft).toBeUndefined();
    expect(result.update.pendingInteraction).toBeUndefined();
    expect(result.update.messages).toEqual([new HumanMessage("Яка адреса?")]);
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

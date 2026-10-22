import { describe, expect, it } from "vitest";

import {
  hasLiveMutationConfirmHitl,
  resumeConfirmBookingHitl,
} from "../booking-hitl.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../../graph/booking-draft.js";

const createCrmPayload = {
  name: "Консультація - Smoke Tester",
  dateStart: "2026-10-24T13:00:00",
  dateEnd: "2026-10-24T13:30:00",
  assignedUserId: "user-1",
  parentType: "Contact",
  parentId: "c-1",
  contactsIds: ["c-1"],
  cServicesIds: ["svc-1"],
  status: "Planned",
};

const liveDraft = () => {
  let draft = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-1", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, {
    type: "command_prepared",
    command: { action: "create", payload: { ...createCrmPayload } },
  });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: {
      kind: "mutation_confirm",
      action: "create",
      effectId: "eff_1",
      frozenCommand: {
        action: "create",
        effectId: "eff_1",
        payload: { ...createCrmPayload },
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "effect_prepared",
    effect: {
      id: "eff_1",
      status: "prepared",
      effect: {
        kind: "create_meeting",
        payload: { ...createCrmPayload },
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: ["confirm", "decline", "menu"],
  });
  return draft;
};

const matchingInterrupt = {
  type: "confirm_booking",
  draft: {
    confirmMessage: "Confirm?",
    command: {
      action: "create",
      payload: { ...createCrmPayload },
    },
  },
};

describe("resumeConfirmBookingHitl", () => {
  it("treats schema-2 alone as not live when mutation_confirm is gone", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    expect(
      hasLiveMutationConfirmHitl({
        bookingDraft: draft,
        pendingInteraction: null,
      }),
    ).toBe(false);
  });

  it("expires ✅ after pendingDecision is cleared (no CRM confirm)", () => {
    const draft = reduceBookingDraft(liveDraft(), { type: "decision_cleared" });
    const draftWithoutCommand = draft == null
      ? null
      : { ...draft, pendingCommand: null };
    const result = resumeConfirmBookingHitl({
      text: "✅",
      bookingDraft: draftWithoutCommand,
      pendingInteraction: { kind: "mutation_confirm", action: "create", choices: [] },
    });
    expect(result.resume).toEqual({ confirmed: false });
    expect(result.update.bookingDraft).toMatchObject({
      pendingCommand: null,
      pendingDecision: null,
    });
  });

  it("confirms live mutation_confirm via callback choice id", () => {
    const draft = liveDraft();
    const result = resumeConfirmBookingHitl({
      text: "",
      callbackChoiceId: "confirm",
      bookingDraft: draft,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [{ id: "confirm", label: "✅" }],
      },
      interruptValue: matchingInterrupt,
    });
    expect(result.resume).toEqual({ confirmed: true });
  });

  it("declines confirm when interrupt payload is tampered", () => {
    const draft = liveDraft();
    const result = resumeConfirmBookingHitl({
      text: "",
      callbackChoiceId: "confirm",
      bookingDraft: draft,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [{ id: "confirm", label: "✅" }],
      },
      interruptValue: {
        type: "confirm_booking",
        draft: {
          command: {
            action: "create",
            payload: { ...createCrmPayload, assignedUserId: "OTHER" },
          },
        },
      },
    });
    expect(result.resume).toEqual({ confirmed: false });
  });

  it("declines confirm when pendingEffect is missing after serialized round-trip", () => {
    // Simulate a paused checkpoint JSON round-trip where pendingEffect was dropped.
    const serialized = JSON.parse(JSON.stringify(liveDraft())) as ReturnType<typeof liveDraft>;
    const withoutEffect = { ...serialized, pendingEffect: null };
    const result = resumeConfirmBookingHitl({
      text: "",
      callbackChoiceId: "confirm",
      bookingDraft: withoutEffect,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [{ id: "confirm", label: "✅" }],
      },
      interruptValue: matchingInterrupt,
    });
    expect(result.resume).toEqual({ confirmed: false });
  });

  it("confirms after serialized paused checkpoint when effect ids still agree", () => {
    const serialized = JSON.parse(JSON.stringify(liveDraft())) as ReturnType<typeof liveDraft>;
    const result = resumeConfirmBookingHitl({
      text: "",
      callbackChoiceId: "confirm",
      bookingDraft: serialized,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [{ id: "confirm", label: "✅" }],
      },
      interruptValue: matchingInterrupt,
    });
    expect(result.resume).toEqual({ confirmed: true });
  });

  it("ignores typed emoji when live confirm requires callback or exact tap with live card", () => {
    const draft = liveDraft();
    expect(hasLiveMutationConfirmHitl({
      bookingDraft: draft,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [],
      },
    })).toBe(true);
    const result = resumeConfirmBookingHitl({
      text: "✅",
      bookingDraft: draft,
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [],
      },
      interruptValue: matchingInterrupt,
    });
    expect(result.resume).toEqual({ confirmed: true });
  });
});

import { describe, expect, it } from "vitest";

import {
  hasLiveMutationConfirmHitl,
  resumeConfirmBookingHitl,
} from "../booking-hitl.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../../graph/booking-draft.js";

const liveDraft = () => {
  let draft = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-1", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, {
    type: "command_prepared",
    command: { action: "create", payload: { serviceId: "svc-1" } },
  });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: { kind: "mutation_confirm", action: "create", effectId: "eff_1" },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: ["confirm", "decline", "menu"],
  });
  return draft;
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
    });
    expect(result.resume).toEqual({ confirmed: true });
  });
});

import { describe, expect, it } from "vitest";

import {
  localizeClarificationReason,
  projectBookingView,
  semanticChoicesFromView,
} from "../view.js";
import type { BookingSessionV2 } from "../session.js";

const baseSession = (): BookingSessionV2 => ({
  schemaVersion: 2,
  revision: 1,
  mode: "create",
  serviceAcceptance: null,
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
});

const cleanReads = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: false,
};

describe("projectBookingView", () => {
  it("uses serviceChoiceIds for service_candidate, not availability ids", () => {
    const view = projectBookingView({
      session: {
        ...baseSession(),
        pendingDecision: { kind: "service_candidate", query: "botox" },
      },
      readModels: cleanReads,
      serviceChoiceIds: ["svc-botox", "svc-peel"],
      availabilityChoiceIds: ["slot-1", "slot-2"],
      choiceLabels: { "svc-botox": "Botox", "svc-peel": "Peel" },
    });
    expect(view.card).toEqual({
      kind: "service_candidate",
      choiceIds: ["svc-botox", "svc-peel"],
    });
    expect(view.replyButtons).toEqual(["Botox", "Peel"]);
  });

  it("projects visit_select with visit copy and choice ids", () => {
    const view = projectBookingView({
      session: {
        ...baseSession(),
        pendingDecision: { kind: "visit_select", stage: "action" },
      },
      readModels: cleanReads,
      locale: "uk",
    });
    expect(view.replyText).toBe("Що зробити із записом?");
    expect(view.card).toEqual({
      kind: "visit_select",
      stage: "action",
      choiceIds: ["reschedule", "cancel", "main_menu"],
    });
  });

  it("localizes clarification tokens instead of emitting them", () => {
    const view = projectBookingView({
      session: {
        ...baseSession(),
        pendingDecision: { kind: "clarification", reason: "effect_id_mismatch" },
      },
      readModels: cleanReads,
      locale: "uk",
    });
    expect(view.replyText).not.toBe("effect_id_mismatch");
    expect(view.replyText).toContain("зіставити");
    expect(localizeClarificationReason("need_lastName", "en")).toBe(
      "Please share your last name.",
    );
    expect(localizeClarificationReason("totally_unknown_token_xyz", "en")).toBe(
      "Please clarify.",
    );
  });

  it("exposes stable semantic choices for restoration", () => {
    const view = projectBookingView({
      session: {
        ...baseSession(),
        pendingDecision: {
          kind: "mutation_confirm",
          action: "create",
          effectId: "eff_1",
        },
      },
      readModels: cleanReads,
    });
    expect(semanticChoicesFromView({ card: view.card })).toEqual([
      { id: "confirm", label: "✅" },
      { id: "decline", label: "❌" },
    ]);
  });
});

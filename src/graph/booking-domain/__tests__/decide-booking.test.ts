import { describe, expect, it } from "vitest";

import { decideBooking } from "../decide.js";
import type { BookingSessionV2 } from "../session.js";
import type { PendingEffect } from "../effects.js";

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

const acceptedReady = (): BookingSessionV2 => ({
  ...baseSession(),
  revision: 5,
  serviceAcceptance: {
    status: "accepted",
    service: { id: "svc-1", name: "Botox", source: "catalog" },
  },
  selectedDate: "2026-09-10",
  selectedSlot: {
    dateStart: "2026-09-10T14:00:00",
    dateEnd: "2026-09-10T14:30:00",
    label: "14:00",
    provenance: "availability_tool",
  },
  note: { status: "skipped" },
  contact: {
    contactId: "c-1",
    phoneNumber: "+380501112233",
    firstName: "Ada",
    lastName: "Lovelace",
  },
});

const cleanReads = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: true,
};

describe("decideBooking kernel", () => {
  it("is deterministic for equal session/input/readModels", () => {
    const session = acceptedReady();
    const a = decideBooking(session, { source: "patient_turn", rawText: "" }, cleanReads);
    const b = decideBooking(session, { source: "patient_turn", rawText: "" }, cleanReads);
    expect(a).toEqual(b);
    expect(a.tag).toBe("mutation_confirm");
  });

  it("control abandon clears the session", () => {
    const decision = decideBooking(
      acceptedReady(),
      { source: "control", intent: "abandon" },
      cleanReads,
    );
    expect(decision.tag).toBe("terminal");
    if (decision.tag === "terminal") {
      expect(decision.session).toBeNull();
      expect(decision.reason).toBe("abandon");
    }
  });

  it("does not replay an unknown mutation write", () => {
    const pending: PendingEffect = {
      id: "eff_1",
      expectedRevision: 5,
      effect: { kind: "create_meeting", payload: { serviceId: "svc-1" } },
      status: "unknown",
    };
    const decision = decideBooking(
      acceptedReady(),
      {
        source: "effect_result",
        result: {
          effectId: "eff_1",
          kind: "mutation",
          action: "create",
          outcome: "unknown",
        },
      },
      cleanReads,
      pending,
    );
    expect(decision.tag).toBe("effect");
    if (decision.tag === "effect") {
      expect(decision.pendingEffect.effect.kind).not.toBe("create_meeting");
      expect(decision.session.pendingCommand).toBeNull();
      expect(decision.session.selectedSlot?.provenance).toBe("unverified_legacy");
    }
  });

  it("rejects mismatched effect ids", () => {
    const pending: PendingEffect = {
      id: "eff_1",
      expectedRevision: 5,
      effect: { kind: "create_meeting", payload: {} },
      status: "executing",
    };
    const decision = decideBooking(
      acceptedReady(),
      {
        source: "effect_result",
        result: {
          effectId: "other",
          kind: "mutation",
          action: "create",
          outcome: "committed",
        },
      },
      cleanReads,
      pending,
    );
    expect(decision.tag).toBe("ask");
    if (decision.tag === "ask") {
      expect(decision.pendingDecision).toEqual({
        kind: "clarification",
        reason: "effect_id_mismatch",
      });
    }
  });

  it("emits availability when date is missing", () => {
    const session = {
      ...baseSession(),
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: "svc-1", source: "catalog" as const },
      },
    };
    const decision = decideBooking(
      session,
      { source: "patient_turn", rawText: "" },
      cleanReads,
    );
    expect(decision.tag).toBe("effect");
    if (decision.tag === "effect") {
      expect(decision.pendingEffect.effect).toMatchObject({
        kind: "present_availability",
        queryKind: "nearest",
      });
    }
  });

  it("applies multi-fact semantic patch without abandoning", () => {
    const decision = decideBooking(
      baseSession(),
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "Botox", serviceId: "svc-1" },
          scheduleIntent: { kind: "date_and_time", date: "2026-09-10", time: "13:00" },
          contactFacts: { phoneNumber: "+380501112233" },
        },
      },
      cleanReads,
    );
    expect(decision.tag).toBe("effect");
    if (decision.tag === "effect") {
      expect(decision.session.serviceAcceptance?.status).toBe("accepted");
      expect(decision.session.selectedDate).toBe("2026-09-10");
      expect(decision.session.contact.phoneNumber).toBe("+380501112233");
      expect(decision.pendingEffect.effect.kind).toBe("present_availability");
    }
  });

  it("keeps accepted facts when asking an informational side question", () => {
    const session = acceptedReady();
    const decision = decideBooking(
      session,
      {
        source: "semantic_patch",
        patch: { informationalQuestion: "Яка адреса?" },
      },
      cleanReads,
    );
    expect(decision.tag).toBe("effect");
    if (decision.tag === "effect") {
      expect(decision.session.serviceAcceptance?.service.id).toBe("svc-1");
      expect(decision.session.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
      expect(decision.pendingEffect.effect.kind).toBe("get_working_time");
    }
  });

  it("never emits create without prerequisites", () => {
    const decision = decideBooking(
      {
        ...baseSession(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-09-10",
        // unverified slot must not mutate
        selectedSlot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
          provenance: "unverified_legacy",
        },
        note: { status: "skipped" },
        contact: { contactId: "c-1" },
      },
      { source: "patient_turn", rawText: "" },
      cleanReads,
    );
    expect(decision.tag).toBe("effect");
    if (decision.tag === "effect") {
      expect(decision.pendingEffect.effect.kind).toBe("present_availability");
    }
  });
});

import { describe, expect, it } from "vitest";

import { reduceBookingDraft, type BookingDraft } from "../../booking/booking-draft.js";
import { decideBooking } from "../decide.js";
import type { BookingReadModels } from "../decision.js";

const emptyReads: BookingReadModels = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: false,
  assignedUserId: "assigned-user-1",
};

describe("deferred turn across catalog + service confirm", () => {
  it("keeps Friday/time/price through catalog select then applies on accept", () => {
    const start = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "Botox" },
          scheduleIntent: {
            kind: "date_and_time",
            date: "2026-10-24",
            time: "13:00",
          },
          informationalQuestion: "price",
          faqTopic: "price",
        },
      },
      emptyReads,
    );

    let draft: BookingDraft | null = null;
    for (const event of start.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.bookingAttemptId).toBeTruthy();
    expect(draft?.deferredTurn?.schedule).toEqual({
      date: "2026-10-24",
      preferredTime: "13:00",
    });
    expect(draft?.deferredTurn?.informational?.topic).toBe("price");
    expect(start.decision.tag).toBe("effect");
    expect(start.decision.pendingEffect?.effect.kind).toBe("list_services");

    // Catalog resolves to one row (accepted: false).
    const afterCatalog = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "catalog",
          outcome: "ok",
          services: [{ id: "svc-botox", name: "Botox" }],
        },
      },
      emptyReads,
    );
    for (const event of afterCatalog.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.serviceAcceptance?.status).toBe("pending");
    expect(draft?.deferredTurn?.schedule?.preferredTime).toBe("13:00");
    expect(draft?.requestedTime).toBeNull();
    expect(draft?.selectedSlot).toBeNull();

    // Patient accepts the offer.
    const afterAccept = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { serviceIntent: { kind: "confirm_pending_service" } },
      },
      emptyReads,
    );
    for (const event of afterAccept.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.serviceAcceptance?.status).toBe("accepted");
    // Price consumed via get_service, or schedule applied toward availability.
    expect(
      afterAccept.decision.pendingEffect?.effect.kind === "get_service"
      || afterAccept.decision.pendingEffect?.effect.kind === "present_availability"
      || draft?.requestedTime?.value === "13:00",
    ).toBe(true);
  });

  it("carries deferred price onto the final availability card facts", () => {
    const start = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "Botox" },
          scheduleIntent: {
            kind: "date_and_time",
            date: "2026-10-24",
            time: "13:00",
          },
          informationalQuestion: "price",
          faqTopic: "price",
        },
      },
      emptyReads,
    );
    let draft: BookingDraft | null = null;
    for (const event of start.events) {
      draft = reduceBookingDraft(draft, event);
    }
    const afterCatalog = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "catalog",
          outcome: "ok",
          services: [{ id: "svc-botox", name: "Botox" }],
        },
      },
      emptyReads,
    );
    for (const event of afterCatalog.events) {
      draft = reduceBookingDraft(draft, event);
    }
    const afterAccept = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { serviceIntent: { kind: "confirm_pending_service" } },
      },
      emptyReads,
    );
    for (const event of afterAccept.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(afterAccept.decision.pendingEffect?.effect.kind).toBe("get_service");

    const afterPrice = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "informational",
          outcome: "ok",
          facts: {
            servicePrice: "1200",
            serviceName: "Botox",
            serviceId: "svc-botox",
          },
        },
      },
      emptyReads,
    );
    for (const event of afterPrice.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(afterPrice.decision.tag).toBe("effect");
    expect(afterPrice.decision.pendingEffect?.effect.kind).toBe("present_availability");
    expect(draft?.pendingReplyFacts?.servicePrice).toBe("1200");

    const afterAvail = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "availability",
          outcome: "ok",
          snapshotId: "snap-price",
          presentationMode: "date_select",
          presentationChoices: [
            { id: "2026-10-24", label: "24 жов" },
          ],
        },
      },
      {
        ...emptyReads,
        availabilitySnapshotId: "snap-price",
        availabilityDays: [
          {
            date: "2026-10-24",
            slots: [
              {
                id: "s1",
                label: "13:00",
                dateStart: "2026-10-24T13:00:00",
                dateEnd: "2026-10-24T13:30:00",
              },
            ],
          },
        ],
      },
    );
    for (const event of afterAvail.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(afterAvail.decision.card?.kind).toMatch(/date_select|time_select/);
    expect(draft?.pendingReplyFacts?.servicePrice).toBe("1200");

    const afterAvailError = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_missing",
          kind: "availability",
          outcome: "error",
        },
      },
      emptyReads,
    );
    // Stash survives an unrelated effect-id mismatch / prior clear; re-set for error path.
    draft = reduceBookingDraft(draft, {
      type: "reply_facts_set",
      facts: { servicePrice: "1200", serviceName: "Botox" },
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_avail_err",
        status: "prepared",
        effect: { kind: "present_availability", queryKind: "exact", date: "2026-10-24" },
      },
    });
    const errorDecision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_avail_err",
          kind: "availability",
          outcome: "error",
        },
      },
      emptyReads,
    );
    for (const event of errorDecision.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.pendingReplyFacts?.servicePrice).toBe("1200");
    expect(
      errorDecision.decision.facts.clarificationReason === "availability_failed"
      || errorDecision.decision.card != null
      || errorDecision.decision.tag === "ask",
    ).toBe(true);
    void afterAvailError;
  });

  it("keeps compound note and firstName through catalog then slot selection", () => {
    const start = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "Botox" },
          scheduleIntent: {
            kind: "date_and_time",
            date: "2026-10-24",
            time: "13:00",
          },
          note: { kind: "answer", value: "for forehead" },
          contactFacts: { firstName: "Olena" },
        },
      },
      emptyReads,
    );

    let draft: BookingDraft | null = null;
    for (const event of start.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(start.events.some((e) => e.type === "booking_started")).toBe(true);
    expect(start.events.some((e) => e.type === "note_status")).toBe(true);
    expect(start.events.some((e) => e.type === "contact_field_submitted")).toBe(true);
    expect(draft?.note).toEqual({ status: "answered", value: "for forehead" });
    expect(draft?.contactDetails?.firstName).toBe("Olena");
    expect(draft?.deferredTurn?.schedule).toEqual({
      date: "2026-10-24",
      preferredTime: "13:00",
    });

    const afterCatalog = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "catalog",
          outcome: "ok",
          services: [{ id: "svc-botox", name: "Botox" }],
        },
      },
      emptyReads,
    );
    for (const event of afterCatalog.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(draft?.note).toEqual({ status: "answered", value: "for forehead" });
    expect(draft?.contactDetails?.firstName).toBe("Olena");

    // Explicit switch to a different service clears the compound note.
    const afterSwitch = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: {
            kind: "catalog_service",
            serviceId: "svc-other",
            serviceName: "Other",
          },
        },
      },
      emptyReads,
    );
    let switched: BookingDraft | null = draft;
    for (const event of afterSwitch.events) {
      switched = reduceBookingDraft(switched, event);
    }
    expect(switched?.serviceAcceptance?.service.id).toBe("svc-other");
    expect(switched?.note.status).toBe("unasked");

    // Compound switch: this-turn note/schedule/price survive unique catalog select.
    draft = reduceBookingDraft(draft, {
      type: "reply_facts_set",
      facts: { servicePrice: "999", serviceName: "Old" },
    });
    const compoundSwitch = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "Botox" },
          scheduleIntent: {
            kind: "date_and_time",
            date: "2026-10-24",
            time: "13:00",
          },
          note: { kind: "answer", value: "switch note" },
          informationalQuestion: "price",
          faqTopic: "price",
        },
      },
      emptyReads,
    );
    for (const event of compoundSwitch.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(compoundSwitch.events.some((e) => e.type === "service_invalidated")).toBe(true);
    expect(draft?.pendingReplyFacts ?? null).toBeNull();
    expect(draft?.note).toEqual({ status: "answered", value: "switch note" });
    expect(draft?.deferredTurn?.schedule).toEqual({
      date: "2026-10-24",
      preferredTime: "13:00",
    });
    expect(draft?.deferredTurn?.informational?.topic).toBe("price");
    expect(draft?.serviceAcceptance).toBeNull();

    const afterSwitchCatalog = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: draft!.pendingEffect!.id,
          kind: "catalog",
          outcome: "ok",
          services: [{ id: "svc-botox", name: "Botox" }],
        },
      },
      emptyReads,
    );
    for (const event of afterSwitchCatalog.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(draft?.note).toEqual({ status: "answered", value: "switch note" });
    expect(draft?.deferredTurn?.schedule).toEqual({
      date: "2026-10-24",
      preferredTime: "13:00",
    });
    expect(draft?.deferredTurn?.informational?.topic).toBe("price");
    expect(draft?.pendingReplyFacts ?? null).toBeNull();

    // Resume original catalog path: note survives accept + slot.
    draft = null;
    for (const event of start.events) {
      draft = reduceBookingDraft(draft, event);
    }
    for (const event of afterCatalog.events) {
      draft = reduceBookingDraft(draft, event);
    }
    const afterAccept = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: { serviceIntent: { kind: "confirm_pending_service" } },
      },
      emptyReads,
    );
    for (const event of afterAccept.events) {
      draft = reduceBookingDraft(draft, event);
    }
    draft = reduceBookingDraft(draft, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-24T13:00:00",
        dateEnd: "2026-10-24T13:30:00",
        label: "13:00",
      },
      snapshotId: "snap-1",
    });
    expect(draft?.note).toEqual({ status: "answered", value: "for forehead" });
    expect(draft?.contactDetails?.firstName).toBe("Olena");
    expect(draft?.selectedSlot?.dateStart).toBe("2026-10-24T13:00:00");
  });

  it("parking side question does not call get_working_time", () => {
    let draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "attempt_test",
    });
    draft = reduceBookingDraft(draft, {
      type: "service_selected",
      service: { id: "svc-1", name: "Consult", source: "catalog" },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "date_select",
        snapshotId: "snap",
        choiceIds: ["2026-10-24"],
        labels: { "2026-10-24": "24 жов" },
      },
    });

    const result = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: {
          informationalQuestion: "Is there parking?",
          faqTopic: "other",
        },
      },
      emptyReads,
    );
    expect(result.decision.intent).toBe("answer_side_question");
    expect(result.decision.facts.clarificationReason).toBe("unknown_faq");
    expect(result.decision.pendingEffect).toBeUndefined();
    expect(result.decision.card?.kind).toBe("date_select");
  });

  it("idle browse does not open a booking draft from catalog_browse alone", () => {
    // catalog_browse without schedule is not isExplicitBookingStart when routed
    // as FAQ capability; kernel path with only catalog_browse still opens list.
    // booking_started requires named_procedure / consultation / schedule+service.
    const result = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: { serviceIntent: { kind: "catalog_browse" } },
      },
      emptyReads,
    );
    // Without booking_started, list_services against null draft may still emit
    // effect_prepared only if openFromNull allows it — effect_prepared alone
    // does not open. Expect no bookingAttemptId.
    let draft: BookingDraft | null = null;
    for (const event of result.events) {
      draft = reduceBookingDraft(draft, event);
    }
    expect(draft?.bookingAttemptId ?? null).toBeNull();
  });
});

describe("booking_started checkpoint emptiness", () => {
  it("isEmptyLegacyBookingDraft is false when attempt/deferred exist", async () => {
    const { isEmptyLegacyBookingDraft } = await import("../../booking/booking-draft.js");
    const draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "attempt_restart",
    });
    const withDeferred = reduceBookingDraft(draft, {
      type: "deferred_turn_set",
      deferred: {
        bookingAttemptId: "attempt_restart",
        boundEffectId: null,
        schedule: { date: "2026-10-24", preferredTime: "13:00" },
        informational: { question: "price", topic: "price" },
      },
    });
    expect(isEmptyLegacyBookingDraft(withDeferred)).toBe(false);
    expect(withDeferred?.deferredTurn?.schedule?.date).toBe("2026-10-24");
  });
});

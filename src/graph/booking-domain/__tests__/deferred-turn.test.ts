import { describe, expect, it } from "vitest";

import { reduceBookingDraft, type BookingDraft } from "../../booking-draft.js";
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
    const { isEmptyLegacyBookingDraft } = await import("../../booking-draft.js");
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

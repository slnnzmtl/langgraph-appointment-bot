import { describe, expect, it } from "vitest";

import { BOOKING_OFFER_MENU, CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../../booking/booking-draft.js";
import type { BookingDecision } from "../../booking-domain/decision.js";
import { projectPendingInteraction } from "../project-pending-interaction.js";
import { choiceIdsFromCard } from "../booking-card-choices.js";

const baseDecision = (
  card: BookingDecision["card"],
  intent: BookingDecision["intent"] = "confirm_service",
): BookingDecision => ({
  tag: "ask",
  intent,
  facts: {},
  card,
});

describe("projectPendingInteraction", () => {
  it("preserves exact card choice IDs for service_confirm", () => {
    const card = {
      kind: "service_confirm" as const,
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
    };
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
      accepted: false,
    });
    const projected = projectPendingInteraction({
      decision: baseDecision(card),
      draft,
      availabilityContext: null,
      previousInteraction: null,
    });
    expect(projected?.kind).toBe("service_confirm");
    expect(projected?.kind === "service_confirm" ? projected.choices.map((c) => c.id) : [])
      .toEqual(choiceIdsFromCard(card));
    expect(projected?.kind === "service_confirm" ? projected.choices.map((c) => c.label) : [])
      .toEqual([...BOOKING_OFFER_MENU]);
  });

  it("localizes service_confirm labels from session locale", () => {
    const card = {
      kind: "service_confirm" as const,
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
    };
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
      accepted: false,
    });
    const projected = projectPendingInteraction({
      decision: baseDecision(card),
      draft,
      availabilityContext: null,
      previousInteraction: null,
      locale: "en",
    });
    expect(projected?.kind === "service_confirm" ? projected.choices.map((c) => c.label) : [])
      .toEqual(["Yes", "Choose another procedure"]);
  });

  it("preserves note_skip id from visit_note card", () => {
    const card = { kind: "visit_note" as const, skipChoiceId: "note_skip" };
    const projected = projectPendingInteraction({
      decision: baseDecision(card, "ask_note"),
      draft: null,
      availabilityContext: null,
      previousInteraction: null,
    });
    expect(projected?.kind).toBe("visit_note");
    expect(projected?.kind === "visit_note" ? projected.choices[0]?.id : null).toBe("note_skip");
  });

  it("copies catalog group serviceIds onto booking-owned chips", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-0", name: "A" },
          { id: "svc-1", name: "B" },
          { id: "svc-2", name: "C" },
        ],
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
          { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
        ],
      },
    });
    const projected = projectPendingInteraction({
      decision: baseDecision(
        {
          kind: "service_candidate",
          choices: [
            { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
            { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
          ],
        },
        "ask_service",
      ),
      draft,
      availabilityContext: null,
      previousInteraction: null,
    });
    expect(projected).toMatchObject({
      kind: "service_candidate",
      owner: "booking",
      utterance: "ботокс",
      query: "ботокс",
      choices: [
        { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
        { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
      ],
    });
  });

  it("preserves FAQ-owned service_candidate when card is null", () => {
    const faqCatalog = {
      kind: "service_candidate" as const,
      utterance: "послуги",
      owner: "faq" as const,
      choices: [{ id: "svc-1", label: "Botox" }],
    };
    const projected = projectPendingInteraction({
      decision: { tag: "reply", intent: "idle", facts: {}, card: null },
      draft: null,
      availabilityContext: null,
      previousInteraction: faqCatalog,
    });
    expect(projected).toBe(faqCatalog);
  });

  it("keeps visit_note while a list_services effect is open", () => {
    const previous = {
      kind: "visit_note" as const,
      choices: [{ id: "note_skip", label: "Продовжити без коментаря" }],
    };
    const projected = projectPendingInteraction({
      decision: {
        tag: "effect",
        intent: "run_effect",
        facts: {},
        card: null,
        pendingEffect: {
          id: "eff_1_list_services",
          expectedRevision: 1,
          effect: { kind: "list_services", query: "ботокс" },
          status: "prepared",
        },
      },
      draft: null,
      availabilityContext: null,
      previousInteraction: previous,
    });
    expect(projected).toBe(previous);
  });

  it("clears booking-owned interaction when card is null", () => {
    const projected = projectPendingInteraction({
      decision: { tag: "reply", intent: "idle", facts: {}, card: null },
      draft: null,
      availabilityContext: null,
      previousInteraction: {
        kind: "service_confirm",
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        choices: [
          { id: "offer_accept", label: "Так" },
          { id: "offer_choose_other", label: "Обрати іншу процедуру" },
        ],
      },
    });
    expect(projected).toBeNull();
  });

  it("embeds availability snapshot on date_select", () => {
    const card = {
      kind: "date_select" as const,
      snapshotId: "snap-1",
      choiceIds: ["2026-10-21", "other_date"],
      labels: { "2026-10-21": "21 жов", other_date: "Інша дата" },
    };
    const projected = projectPendingInteraction({
      decision: baseDecision(card, "present_dates"),
      draft: null,
      availabilityContext: {
        days: [{
          date: "2026-10-21",
          dayLabel: "21 жов",
          slots: [{
            id: "s1",
            label: "10:00",
            dateStart: "2026-10-21T10:00:00+03:00",
            dateEnd: "2026-10-21T10:30:00+03:00",
          }],
        }],
        stepMinutes: 30,
      },
      previousInteraction: null,
    });
    expect(projected?.kind).toBe("date_select");
    if (projected?.kind === "date_select") {
      expect(projected.snapshot.snapshotId).toBe("snap-1");
      expect(projected.snapshot.days).toHaveLength(1);
      expect(projected.choices.map((c) => c.id)).toEqual(["2026-10-21", "other_date"]);
    }
  });
});

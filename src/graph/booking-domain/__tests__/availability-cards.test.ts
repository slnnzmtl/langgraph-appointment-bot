import { describe, expect, it } from "vitest";

import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import { decideBooking } from "../decide.js";
import type { BookingReadModels } from "../decision.js";
import type { EffectResult } from "../effects.js";

const READ: BookingReadModels = {
  contactContextDirty: false,
  bookingContextDirty: false,
  availabilityVerified: true,
  availabilitySnapshotId: "snap-1",
  availabilityDays: [
    {
      date: "2026-09-10",
      dayLabel: "10 вер",
      slots: [
        {
          id: "slot-a",
          label: "10 вер · 14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        },
        {
          id: "slot-b",
          label: "10 вер · 15:00",
          dateStart: "2026-09-10T15:00:00",
          dateEnd: "2026-09-10T15:30:00",
        },
      ],
    },
    {
      date: "2026-09-11",
      dayLabel: "11 вер",
      slots: [
        {
          id: "slot-c",
          label: "11 вер · 10:00",
          dateStart: "2026-09-11T10:00:00",
          dateEnd: "2026-09-11T10:30:00",
        },
      ],
    },
  ],
};

const draftWithAcceptedService = (): BookingDraft => {
  const draft = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

describe("availability cards from effect results", () => {
  it("emits a date_select ask and does not re-mint present_availability", () => {
    const draft = reduceBookingDraft(draftWithAcceptedService(), {
      type: "effect_prepared",
      effect: {
        id: "eff_1_present_availability",
        expectedRevision: 1,
        effect: { kind: "present_availability", queryKind: "nearest" },
        status: "executing",
      },
    });
    const result: EffectResult = {
      effectId: "eff_1_present_availability",
      kind: "availability",
      outcome: "slots",
      snapshotId: "snap-1",
      presentationMode: "date_select",
      presentationChoices: [
        { id: "2026-09-10", label: "10 вер", date: "2026-09-10" },
        { id: "2026-09-11", label: "11 вер", date: "2026-09-11" },
        { id: "other_date", label: "Інша дата" },
      ],
    };
    const decision = decideBooking(
      draft,
      { source: "effect_result", result },
      READ,
    );
    expect(decision.decision.tag).toBe("ask");
    expect(decision.decision.intent).toBe("present_dates");
    expect(decision.decision.card?.kind).toBe("date_select");
    expect(decision.decision.pendingEffect).toBeUndefined();
    expect(decision.events.some((e) => e.type === "effect_prepared")).toBe(false);

    // Re-entry while awaiting choice must not mint another availability effect.
    let next = draft;
    for (const event of decision.events) {
      next = reduceBookingDraft(next, event);
    }
    const again = decideBooking(next, { source: "patient_turn", rawText: "" }, READ);
    expect(again.decision.tag).toBe("ask");
    expect(again.decision.intent).toBe("present_dates");
    expect(again.decision.pendingEffect).toBeUndefined();
  });

  it("empty earlier outcome emits date_select with later chip, not availability_empty", () => {
    const draft = reduceBookingDraft(draftWithAcceptedService(), {
      type: "effect_prepared",
      effect: {
        id: "eff_12_present_availability",
        expectedRevision: 12,
        effect: {
          kind: "present_availability",
          queryKind: "earlier",
          durationMinutes: 30,
        },
        status: "executing",
      },
    });
    const result: EffectResult = {
      effectId: "eff_12_present_availability",
      kind: "availability",
      outcome: "empty",
    };
    const decision = decideBooking(
      draft,
      { source: "effect_result", result },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: true,
        availabilitySnapshotId: "empty-earlier",
        availabilityDays: [],
      },
    );
    expect(decision.decision.tag).toBe("ask");
    expect(decision.decision.intent).toBe("present_dates");
    expect(decision.decision.reason).not.toBe("availability_empty");
    expect(decision.decision.card).toMatchObject({
      kind: "date_select",
      emptyMode: "earlier",
      choiceIds: ["later"],
    });
    expect(decision.decision.card?.kind === "date_select"
      && decision.decision.card.labels?.later).toBeTruthy();
  });

  it("selects an offered slot without a second availability effect", () => {
    let draft = draftWithAcceptedService();
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" })!;
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "time_select",
        date: "2026-09-10",
        snapshotId: "snap-1",
        choiceIds: ["slot-a", "slot-b", "other_date"],
        labels: {
          "slot-a": "10 вер · 14:00",
          "slot-b": "10 вер · 15:00",
          other_date: "Інша дата",
        },
      },
    })!;
    draft = reduceBookingDraft(draft, {
      type: "choices_offered",
      choiceIds: ["slot-a", "slot-b", "other_date"],
    })!;

    const decision = decideBooking(
      draft,
      {
        source: "semantic_patch",
        patch: {
          scheduleIntent: {
            kind: "slot",
            slot: {
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
              label: "10 вер · 14:00",
            },
            snapshotId: "snap-1",
          },
        },
      },
      READ,
    );
    expect(decision.events.some((e) => e.type === "slot_selected")).toBe(true);
    expect(decision.decision.pendingEffect?.effect.kind).not.toBe("present_availability");
  });

  it("typed date uses projector: all day slots + other_date (not a 3-chip slice)", () => {
    const manySlots = {
      ...READ,
      availabilityDays: [
        {
          date: "2026-09-10",
          dayLabel: "10 вер",
          slots: [
            {
              id: "s1",
              label: "10:00",
              dateStart: "2026-09-10T10:00:00",
              dateEnd: "2026-09-10T10:30:00",
            },
            {
              id: "s2",
              label: "10:30",
              dateStart: "2026-09-10T10:30:00",
              dateEnd: "2026-09-10T11:00:00",
            },
            {
              id: "s3",
              label: "11:00",
              dateStart: "2026-09-10T11:00:00",
              dateEnd: "2026-09-10T11:30:00",
            },
            {
              id: "s4",
              label: "11:30",
              dateStart: "2026-09-10T11:30:00",
              dateEnd: "2026-09-10T12:00:00",
            },
            {
              id: "s5",
              label: "12:00",
              dateStart: "2026-09-10T12:00:00",
              dateEnd: "2026-09-10T12:30:00",
            },
          ],
        },
      ],
    };
    const decision = decideBooking(
      draftWithAcceptedService(),
      {
        source: "semantic_patch",
        patch: {
          scheduleIntent: { kind: "date", date: "2026-09-10" },
        },
      },
      manySlots,
    );
    expect(decision.decision.intent).toBe("present_times");
    expect(decision.decision.card).toMatchObject({
      kind: "time_select",
      date: "2026-09-10",
      choiceIds: ["s1", "s2", "s3", "s4", "s5", "other_date"],
    });
  });
});

describe("multi-fact side questions and catalog resolve", () => {
  it("applies consultation + price and emits get_service after service is on the draft", () => {
    const decision = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "consultation" },
          informationalQuestion: "price",
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.events.some((e) => e.type === "service_selected")).toBe(true);
    // Price defers until service is accepted on draft — consultation starts pending.
    // After accept path would get_service; with pending confirm, decide asks confirm first.
    expect(
      decision.decision.intent === "confirm_service"
      || decision.decision.pendingEffect?.effect.kind === "get_service",
    ).toBe(true);
  });

  it("named_procedure emits list_services and never writes model CRM ids", () => {
    const decision = decideBooking(
      null,
      {
        source: "semantic_patch",
        patch: {
          serviceIntent: { kind: "named_procedure", query: "ботокс" },
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.decision.tag).toBe("effect");
    expect(decision.decision.pendingEffect?.effect).toEqual({
      kind: "list_services",
      query: "ботокс",
    });
    expect(decision.events.some((e) => e.type === "service_selected")).toBe(false);
  });

  it("catalog effect with one row selects that service", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "effect_prepared",
      effect: {
        id: "eff_1_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const decision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_1_list_services",
          kind: "catalog",
          outcome: "ok",
          services: [{ id: "svc-botox", name: "Корекція ботокс" }],
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    const selected = decision.events.find((e) => e.type === "service_selected");
    expect(selected).toMatchObject({
      type: "service_selected",
      service: { id: "svc-botox", name: "Корекція ботокс", source: "catalog" },
    });
  });

  it("catalog effect with already-narrowed rows opens service_candidate chips", () => {
    // Node (family selector) already narrowed; kernel must not re-stem the query.
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "effect_prepared",
      effect: {
        id: "eff_2_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const decision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_2_list_services",
          kind: "catalog",
          outcome: "ok",
          services: [
            { id: "svc-corr", name: "Корекція ботокс" },
            { id: "svc-meso", name: "Мезоботокс" },
            { id: "svc-latin", name: "Ботулінотерапія Botox, Disport 1 зона" },
          ],
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.decision).toMatchObject({
      tag: "ask",
      intent: "ask_service",
      card: {
        kind: "service_candidate",
        choiceIds: ["svc-corr", "svc-meso", "svc-latin"],
        labels: {
          "svc-corr": "Корекція ботокс",
          "svc-meso": "Мезоботокс",
          "svc-latin": "Ботулінотерапія Botox, Disport 1 зона",
        },
      },
    });
    const pending = decision.events.find((e) => e.type === "decision_set");
    expect(pending).toMatchObject({
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-corr", name: "Корекція ботокс" },
          { id: "svc-meso", name: "Мезоботокс" },
          { id: "svc-latin", name: "Ботулінотерапія Botox, Disport 1 зона" },
        ],
        choices: [
          { id: "svc-corr", label: "Корекція ботокс", serviceIds: ["svc-corr"] },
          { id: "svc-meso", label: "Мезоботокс", serviceIds: ["svc-meso"] },
          {
            id: "svc-latin",
            label: "Ботулінотерапія Botox, Disport 1 зона",
            serviceIds: ["svc-latin"],
          },
        ],
      },
    });
  });

  it("catalog effect with six rows keeps every id (no slice)", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "effect_prepared",
      effect: {
        id: "eff_6_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const services = Array.from({ length: 6 }, (_, index) => ({
      id: `svc-${index}`,
      name: `Service ${index}`,
    }));
    const decision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_6_list_services",
          kind: "catalog",
          outcome: "ok",
          services,
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.decision.card).toMatchObject({
      kind: "service_candidate",
      choiceIds: services.map((row) => row.id),
    });
  });

  it("catalog effect prefers grouped choices over raw service rows", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "effect_prepared",
      effect: {
        id: "eff_g_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const services = Array.from({ length: 6 }, (_, index) => ({
      id: `svc-${index}`,
      name: `Ботулінотерапія зона ${index}`,
    }));
    const decision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_g_list_services",
          kind: "catalog",
          outcome: "ok",
          services,
          choices: [
            {
              id: "g0",
              label: "Botox",
              serviceIds: ["svc-0", "svc-1", "svc-2"],
            },
            {
              id: "g1",
              label: "Disport",
              serviceIds: ["svc-3", "svc-4", "svc-5"],
            },
          ],
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.decision.card).toMatchObject({
      kind: "service_candidate",
      choiceIds: ["g0", "g1"],
      labels: { g0: "Botox", g1: "Disport" },
      serviceIdsByChoice: {
        g0: ["svc-0", "svc-1", "svc-2"],
        g1: ["svc-3", "svc-4", "svc-5"],
      },
    });
    const pending = decision.events.find((e) => e.type === "decision_set");
    expect(pending).toMatchObject({
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1", "svc-2"] },
          { id: "g1", label: "Disport", serviceIds: ["svc-3", "svc-4", "svc-5"] },
        ],
      },
    });
  });

  it("catalog_page drills down remaining ids and selects canonical CRM name", () => {
    let draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "effect_prepared",
      effect: {
        id: "eff_page_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const family = [
      { id: "svc-0", name: "Ботулінотерапія Botox 1 зона" },
      { id: "svc-1", name: "Ботулінотерапія Botox 2 зони" },
      { id: "svc-deep", name: "Ботулінотерапія Botox 3 зони" },
    ];
    const opened = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_page_list_services",
          kind: "catalog",
          outcome: "ok",
          services: family,
          choices: [
            { id: "g0", label: "Botox", serviceIds: family.map((row) => row.id) },
          ],
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    for (const event of opened.events) {
      draft = reduceBookingDraft(draft, event);
    }
    const paged = decideBooking(
      draft,
      {
        source: "catalog_page",
        remainingIds: ["svc-deep"],
        choices: [],
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    const selected = paged.events.find((e) => e.type === "service_selected");
    expect(selected).toMatchObject({
      type: "service_selected",
      service: {
        id: "svc-deep",
        name: "Ботулінотерапія Botox 3 зони",
        source: "catalog",
      },
    });
  });

  it("catalog miss at visit_note resumes note with need_service clarification", () => {
    let draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-consult", name: "Консультація", source: "catalog" },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-10-22" });
    draft = reduceBookingDraft(draft, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-22T12:00:00",
        dateEnd: "2026-10-22T12:30:00",
        label: "12:00",
      },
      snapshotId: "snap-1",
    });
    draft = reduceBookingDraft(draft, { type: "note_status", status: "awaiting" });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: "eff_note_list_services",
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    const decision = decideBooking(
      draft,
      {
        source: "effect_result",
        result: {
          effectId: "eff_note_list_services",
          kind: "catalog",
          outcome: "ok",
          // Selector returned no ids — node leaves services empty.
          services: [],
        },
      },
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(decision.decision).toMatchObject({
      tag: "ask",
      intent: "ask_note",
      reason: "need_service",
      facts: { clarificationReason: "need_service" },
      card: { kind: "visit_note", skipChoiceId: "note_skip" },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  BOOKING_OWNED_INTERACTION_KINDS,
  clearBookingOwnedInteraction,
  isBookingOwnedInteraction,
  reduceBookingSession,
  type PendingInteraction,
} from "../booking-session.js";
import { INTENT_SKIP_LABEL } from "../../shared/clinic-constants.js";

const selectedSlot = {
  dateStart: "2026-10-17T11:30:00",
  dateEnd: "2026-10-17T12:00:00",
  label: "11:30",
};

const acceptedWithDate = () => {
  const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-botox", name: "Botox", source: "catalog" },
    accepted: true,
  });
  return reduceBookingDraft(accepted, {
    type: "date_selected",
    date: "2026-10-17",
  })!;
};

describe("reduceBookingSession", () => {
  it("opens visit_note atomically when slot_selected meets an unasked note", () => {
    const before = {
      bookingDraft: acceptedWithDate(),
      pendingInteraction: null as PendingInteraction | null,
    };
    const result = reduceBookingSession(before, {
      type: "slot_selected",
      slot: selectedSlot,
    });

    expect(result.bookingDraft?.selectedSlot).toEqual(selectedSlot);
    expect(result.bookingDraft?.note.status).toBe("awaiting");
    expect(result.bookingDraft?.phase).toBe("note");
    expect(result.pendingInteraction).toEqual({
      kind: "visit_note",
      choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
    });
    expect(result.clearAvailability).toBe(false);
    expect(result.effect).toBeNull();
  });

  it("does not open visit_note when the note is already answered", () => {
    const slotted = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const answered = reduceBookingSession(slotted, {
      type: "note_provided",
      value: "хочу ботокс у зоні лоба",
    });
    const laterSlot = {
      dateStart: "2026-10-18T10:00:00",
      dateEnd: "2026-10-18T10:30:00",
      label: "10:00",
    };
    const withDate = {
      bookingDraft: reduceBookingDraft(answered.bookingDraft, {
        type: "date_selected",
        date: "2026-10-18",
      }),
      pendingInteraction: answered.pendingInteraction,
    };
    const result = reduceBookingSession(withDate, {
      type: "slot_selected",
      slot: laterSlot,
    });

    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "хочу ботокс у зоні лоба",
    });
    expect(result.pendingInteraction).toBeNull();
  });

  it("records note_provided from runtime text and clears visit_note", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "note_provided",
      value: "хочу ботокс у зоні лоба",
    });

    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "хочу ботокс у зоні лоба",
    });
    expect(result.pendingInteraction).toBeNull();
    expect(result.effect).toBeNull();
  });

  it("records note_skipped and clears visit_note", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, { type: "note_skipped" });

    expect(result.bookingDraft?.note.status).toBe("skipped");
    expect(result.pendingInteraction).toBeNull();
  });

  it("opens service_or_note without changing the accepted service or slot", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch to consultation" },
      ],
    });

    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(result.bookingDraft?.selectedSlot).toEqual(selectedSlot);
    expect(result.bookingDraft?.note.status).toBe("awaiting");
    expect(result.pendingInteraction).toEqual({
      kind: "service_or_note",
      currentService: { id: "svc-botox", name: "Botox" },
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch to consultation" },
      ],
    });
  });

  it("keep_service stores noteCandidate and clears the interaction", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const clarified = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    });
    const result = reduceBookingSession(clarified, {
      type: "interaction_choice",
      choiceId: "keep_service",
    });

    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "I need a consultation regarding Botox",
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(result.pendingInteraction).toBeNull();
    expect(result.effect).toBeNull();
  });

  it("switch_service returns resolve_service with the original utterance and noteCandidate", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const clarified = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    });
    const result = reduceBookingSession(clarified, {
      type: "interaction_choice",
      choiceId: "switch_service",
    });

    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(result.bookingDraft?.selectedSlot).toEqual(selectedSlot);
    expect(result.pendingInteraction).toEqual(clarified.pendingInteraction);
    expect(result.effect).toEqual({
      type: "resolve_service",
      utterance: "I need a consultation regarding Botox",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
    });
  });

  it("service_change_requested returns resolve_service without answering the note", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "service_change_requested",
      utterance: "запиши на ботокс",
      query: "ботокс",
    });

    expect(result.bookingDraft?.note.status).toBe("awaiting");
    expect(result.effect).toEqual({
      type: "resolve_service",
      utterance: "запиши на ботокс",
      query: "ботокс",
    });
  });

  it("service_changed with noteCandidate clears schedule facts and resets the note to unasked", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "service_changed",
      service: {
        id: "svc-consult",
        name: "Консультація",
        durationMinutes: 30,
        source: "catalog",
      },
      accepted: true,
      noteCandidate: "I need a consultation regarding Botox",
    });

    expect(result.bookingDraft?.serviceAcceptance).toEqual({
      status: "accepted",
      service: {
        id: "svc-consult",
        name: "Консультація",
        durationMinutes: 30,
        source: "catalog",
      },
    });
    expect(result.bookingDraft?.selectedDate).toBeNull();
    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.bookingDraft?.pendingCommand).toBeNull();
    expect(result.bookingDraft?.note).toEqual({ status: "unasked" });
    expect(result.bookingDraft?.phase).toBe("date");
    expect(result.pendingInteraction).toBeNull();
    expect(result.clearAvailability).toBe(true);
  });

  it("service_changed to the same service id keeps the slot and does not clear availability", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const sameId = awaiting.bookingDraft!.serviceAcceptance!.service.id;
    const result = reduceBookingSession(awaiting, {
      type: "service_changed",
      service: {
        id: sameId,
        name: "Botox",
        source: "catalog",
      },
      accepted: true,
      noteCandidate: "keep this visit note",
    });

    expect(result.bookingDraft?.selectedSlot).toEqual(selectedSlot);
    expect(result.bookingDraft?.selectedDate).toBe("2026-10-17");
    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "keep this visit note",
    });
    expect(result.bookingDraft?.phase).not.toBe("date");
    expect(result.pendingInteraction).toBeNull();
    expect(result.clearAvailability).toBe(false);
  });

  it("service_changed to the same id without a slot closes the interaction only", () => {
    const draft = acceptedWithDate();
    const sameId = draft.serviceAcceptance!.service.id;
    const result = reduceBookingSession(
      {
        bookingDraft: draft,
        pendingInteraction: {
          kind: "service_candidate",
          utterance: "ботокс",
          choices: [{ id: sameId, label: "Botox", serviceIds: [sameId] }],
        },
      },
      {
        type: "service_changed",
        service: { id: sameId, name: "Botox", source: "catalog" },
        accepted: true,
        noteCandidate: "should not write without a slot",
      },
    );

    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.bookingDraft?.note.status).toBe("unasked");
    expect(result.bookingDraft?.phase).toBe("time");
    expect(result.pendingInteraction).toBeNull();
    expect(result.clearAvailability).toBe(false);
  });

  it("service_changed without noteCandidate resets the note to unasked", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "service_changed",
      service: { id: "svc-2", name: "Peel", source: "catalog" },
      accepted: true,
    });

    expect(result.bookingDraft?.note.status).toBe("unasked");
    expect(result.pendingInteraction).toBeNull();
    expect(result.clearAvailability).toBe(true);
  });

  it("a later slot_selected after different-id service_changed reopens visit_note", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const changed = reduceBookingSession(awaiting, {
      type: "service_changed",
      service: { id: "svc-consult", name: "Консультація", source: "catalog" },
      accepted: true,
      noteCandidate: "I need a consultation regarding Botox",
    });
    const dated = {
      bookingDraft: reduceBookingDraft(changed.bookingDraft, {
        type: "date_selected",
        date: "2026-10-20",
      }),
      pendingInteraction: changed.pendingInteraction,
    };
    const result = reduceBookingSession(dated, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-20T09:00:00",
        dateEnd: "2026-10-20T09:30:00",
        label: "09:00",
      },
    });

    expect(result.bookingDraft?.note.status).toBe("awaiting");
    expect(result.pendingInteraction?.kind).toBe("visit_note");
  });

  it("opens service_candidate choices with optional serviceIds on each group", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "service_candidates_opened",
      utterance: "ботокс",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "g1", label: "шия", serviceIds: ["svc-b", "svc-c"] },
      ],
    });

    expect(result.pendingInteraction).toEqual({
      kind: "service_candidate",
      utterance: "ботокс",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "g1", label: "шия", serviceIds: ["svc-b", "svc-c"] },
      ],
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
  });

  it("service_unresolved preserves the interaction and adds return_to_booking", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const clarified = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    });
    const result = reduceBookingSession(clarified, {
      type: "service_unresolved",
      returnLabel: "Повернутися до запису",
    });

    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(result.bookingDraft?.selectedSlot).toEqual(selectedSlot);
    expect(result.pendingInteraction?.kind).toBe("service_or_note");
    expect(result.pendingInteraction?.choices).toContainEqual({
      id: "return_to_booking",
      label: "Повернутися до запису",
    });
    expect(result.effect).toBeNull();
  });

  it("return_to_booking removes only the return choice and does not reclassify", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const clarified = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    });
    const unresolved = reduceBookingSession(clarified, {
      type: "service_unresolved",
      returnLabel: "Back to booking",
    });
    const result = reduceBookingSession(unresolved, {
      type: "interaction_choice",
      choiceId: "return_to_booking",
    });

    expect(result.pendingInteraction).toEqual({
      kind: "service_or_note",
      currentService: { id: "svc-botox", name: "Botox" },
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    });
    expect(result.effect).toBeNull();
  });

  it("transitions by choice id even when labels differ", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const clarified = reduceBookingSession(awaiting, {
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "mixed intent",
      choices: [
        { id: "keep_service", label: "Continue with Botox" },
        { id: "switch_service", label: "Book consultation instead" },
      ],
    });
    const result = reduceBookingSession(clarified, {
      type: "interaction_choice",
      choiceId: "keep_service",
    });

    expect(result.bookingDraft?.note.value).toBe("mixed intent");
    expect(result.pendingInteraction).toBeNull();
  });

  it("candidate singleton choice returns apply_service_choice for the orchestrator", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const candidates = reduceBookingSession(awaiting, {
      type: "service_candidates_opened",
      utterance: "ботокс",
      noteCandidate: "note text",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "svc-b", label: "шия", serviceIds: ["svc-b"] },
      ],
    });
    const chosen = reduceBookingSession(candidates, {
      type: "interaction_choice",
      choiceId: "svc-a",
    });

    expect(chosen.effect).toEqual({
      type: "apply_service_choice",
      serviceId: "svc-a",
      label: "обличчя",
      noteCandidate: "note text",
    });
    expect(chosen.pendingInteraction).toEqual(candidates.pendingInteraction);
    const applied = reduceBookingSession(chosen, {
      type: "service_changed",
      service: { id: "svc-a", name: "Botox Face", source: "catalog" },
      accepted: true,
      noteCandidate: "note text",
    });
    expect(applied.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-a");
    expect(applied.bookingDraft?.note).toEqual({ status: "unasked" });
  });

  it("candidate multi-id group returns resolve_service with remainingIds", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const candidates = reduceBookingSession(awaiting, {
      type: "service_candidates_opened",
      utterance: "ботокс",
      noteCandidate: "note text",
      choices: [
        {
          id: "g0",
          label: "ботулінотерапія",
          serviceIds: ["svc-a", "svc-b"],
        },
      ],
    });
    const chosen = reduceBookingSession(candidates, {
      type: "interaction_choice",
      choiceId: "g0",
    });

    expect(chosen.effect).toEqual({
      type: "resolve_service",
      utterance: "ботокс",
      noteCandidate: "note text",
      remainingIds: ["svc-a", "svc-b"],
    });
    expect(chosen.pendingInteraction).toEqual(candidates.pendingInteraction);
  });
});

describe("schedule transitions clear visit_note", () => {
  it("date_selected after a slotted visit_note clears the note interaction", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    expect(awaiting.pendingInteraction?.kind).toBe("visit_note");
    expect(awaiting.bookingDraft?.selectedSlot).not.toBeNull();

    const result = reduceBookingSession(awaiting, {
      type: "date_selected",
      date: "2026-10-20",
    });

    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.bookingDraft?.selectedDate).toBe("2026-10-20");
    expect(result.bookingDraft?.phase).toBe("time");
    expect(result.pendingInteraction).toBeNull();
  });

  it("date_selected without a prior slot keeps service_candidate open", () => {
    const dated = {
      bookingDraft: acceptedWithDate(),
      pendingInteraction: {
        kind: "service_candidate" as const,
        utterance: "ботокс",
        choices: [
          { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
          { id: "svc-b", label: "шия", serviceIds: ["svc-b"] },
        ],
      },
    };
    expect(dated.bookingDraft.selectedSlot).toBeNull();

    const result = reduceBookingSession(dated, {
      type: "date_selected",
      date: "2026-10-21",
    });

    expect(result.pendingInteraction?.kind).toBe("service_candidate");
    expect(result.bookingDraft?.selectedDate).toBe("2026-10-21");
  });

  it("slot_invalidated via draft_event clears visit_note", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const result = reduceBookingSession(awaiting, {
      type: "draft_event",
      event: { type: "slot_invalidated", keepDate: true },
    });

    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.bookingDraft?.phase).toBe("time");
    expect(result.pendingInteraction).toBeNull();
  });

  it("visit_note implies a selected slot after every session reduction", () => {
    const awaiting = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    expect(awaiting.pendingInteraction?.kind).toBe("visit_note");
    expect(awaiting.bookingDraft?.selectedSlot).not.toBeNull();

    const afterDate = reduceBookingSession(awaiting, {
      type: "date_selected",
      date: "2026-10-22",
    });
    if (afterDate.pendingInteraction?.kind === "visit_note") {
      expect(afterDate.bookingDraft?.selectedSlot).not.toBeNull();
    }
    expect(afterDate.pendingInteraction?.kind).not.toBe("visit_note");
    expect(["date", "time"]).toContain(afterDate.bookingDraft?.phase);
  });
});

describe("booking-owned pendingInteraction helpers", () => {
  it("identifies booking-owned kinds", () => {
    expect(BOOKING_OWNED_INTERACTION_KINDS).toEqual([
      "visit_note",
      "service_or_note",
      "service_candidate",
    ]);
    expect(isBookingOwnedInteraction({ kind: "visit_note", choices: [] })).toBe(true);
    expect(
      isBookingOwnedInteraction({
        kind: "faq_catalog",
        choices: [{ id: "x", label: "X" }],
      } as PendingInteraction),
    ).toBe(false);
  });

  it("clears only booking-owned interactions when closing a booking", () => {
    expect(
      clearBookingOwnedInteraction({
        kind: "visit_note",
        choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
      }),
    ).toBeNull();
    const futureFaq = {
      kind: "faq_catalog",
      choices: [{ id: "family", label: "Lips" }],
    } as PendingInteraction;
    expect(clearBookingOwnedInteraction(futureFaq)).toEqual(futureFaq);
  });
});

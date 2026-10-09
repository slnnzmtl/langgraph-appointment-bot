import { describe, expect, it } from "vitest";

import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  BOOKING_OWNED_INTERACTION_KINDS,
  clearBookingOwnedInteraction,
  interpretInteractionReply,
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
      owner: "booking",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "g1", label: "шия", serviceIds: ["svc-b", "svc-c"] },
      ],
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
  });

  it("service_offered opens service_confirm with accept/choose_other choice ids", () => {
    const result = reduceBookingSession(
      { bookingDraft: null, pendingInteraction: null },
      {
        type: "service_offered",
        service: { id: "svc-consult", name: "Консультація", source: "catalog" },
      },
    );
    expect(result.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: "svc-consult" },
    });
    expect(result.pendingInteraction?.kind).toBe("service_confirm");
    expect(result.pendingInteraction?.choices.map((c) => c.id)).toEqual([
      "accept",
      "choose_other",
    ]);
  });

  it("accept on service_confirm accepts the service; choose_other opens catalog_detour", () => {
    const offered = reduceBookingSession(
      { bookingDraft: null, pendingInteraction: null },
      {
        type: "service_offered",
        service: { id: "svc-consult", name: "Консультація", source: "catalog" },
        acceptLabel: "Yes",
        chooseOtherLabel: "Other",
      },
    );
    const accepted = reduceBookingSession(offered, {
      type: "interaction_choice",
      choiceId: "accept",
    });
    expect(accepted.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(accepted.pendingInteraction).toBeNull();

    const other = reduceBookingSession(offered, {
      type: "interaction_choice",
      choiceId: "choose_other",
    });
    expect(other.bookingDraft?.serviceAcceptance?.status).toBe("pending");
    expect(other.pendingInteraction?.kind).toBe("catalog_detour");
    expect(other.effect).toEqual({ type: "open_faq_catalog" });
  });

  it("service_confirm_schedule accepts the service and applies the date atomically", () => {
    const offered = reduceBookingSession(
      { bookingDraft: null, pendingInteraction: null },
      {
        type: "service_offered",
        service: { id: "svc-consult", name: "Консультація", source: "catalog" },
      },
    );
    const scheduled = reduceBookingSession(offered, {
      type: "service_confirm_schedule",
      schedule: { type: "date_selected", date: "2026-10-20" },
    });
    expect(scheduled.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(scheduled.bookingDraft?.selectedDate).toBe("2026-10-20");
    expect(scheduled.pendingInteraction).toBeNull();
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

  it("service_unresolved with no interaction opens catalog_detour, not visit_note", () => {
    const timeDraft = acceptedWithDate();
    expect(timeDraft.phase).toBe("time");
    expect(timeDraft.selectedSlot).toBeNull();
    const result = reduceBookingSession(
      { bookingDraft: timeDraft, pendingInteraction: null },
      { type: "service_unresolved", returnLabel: "Повернутися до запису" },
    );

    expect(result.pendingInteraction).toEqual({
      kind: "catalog_detour",
      choices: [{ id: "return_to_booking", label: "Повернутися до запису" }],
    });
    expect(result.bookingDraft?.note).toEqual({ status: "unasked" });
    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.bookingDraft?.phase).toBe("time");
  });

  it("return_to_booking on catalog_detour clears the interaction", () => {
    const timeDraft = acceptedWithDate();
    const unresolved = reduceBookingSession(
      { bookingDraft: timeDraft, pendingInteraction: null },
      { type: "service_unresolved", returnLabel: "Повернутися до запису" },
    );
    const result = reduceBookingSession(unresolved, {
      type: "interaction_choice",
      choiceId: "return_to_booking",
    });

    expect(result.pendingInteraction).toBeNull();
    expect(result.bookingDraft?.phase).toBe("time");
    expect(result.bookingDraft?.note.status).toBe("unasked");
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
      "catalog_detour",
      "service_confirm",
      "date_select",
      "time_select",
      "visit_select",
      "contact_field",
      "mutation_confirm",
    ]);
    expect(isBookingOwnedInteraction({ kind: "visit_note", choices: [] })).toBe(true);
    expect(isBookingOwnedInteraction({
      kind: "catalog_detour",
      choices: [{ id: "return_to_booking", label: "Back" }],
    })).toBe(true);
  });

  it("clears booking-owned interactions when closing a booking", () => {
    expect(
      clearBookingOwnedInteraction({
        kind: "visit_note",
        choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
      }),
    ).toBeNull();
    expect(
      clearBookingOwnedInteraction({
        kind: "catalog_detour",
        choices: [{ id: "return_to_booking", label: "Back" }],
      }),
    ).toBeNull();
  });
});

describe("mutation_chat_other", () => {
  it("invalidates create slot while keeping mutation_confirm open", () => {
    const drafted = reduceBookingSession(
      { bookingDraft: acceptedWithDate(), pendingInteraction: null },
      { type: "slot_selected", slot: selectedSlot },
    );
    const withCommand = {
      bookingDraft: reduceBookingDraft(drafted.bookingDraft!, {
        type: "command_prepared",
        command: {
          action: "create" as const,
          payload: { serviceId: "svc-1", dateStart: selectedSlot.dateStart },
        },
      }),
      pendingInteraction: null as PendingInteraction | null,
    };
    const opened = reduceBookingSession(withCommand, {
      type: "mutation_confirm_opened",
      action: "create",
    });
    expect(opened.pendingInteraction?.kind).toBe("mutation_confirm");

    const other = reduceBookingSession(opened, { type: "mutation_chat_other" });
    expect(other.pendingInteraction?.kind).toBe("mutation_confirm");
    expect(other.bookingDraft?.selectedSlot).toBeNull();
    expect(other.bookingDraft?.selectedDate).toBe(selectedSlot.dateStart.slice(0, 10));
    expect(other.bookingDraft?.pendingCommand).toBeNull();
  });
});

describe("interpretInteractionReply", () => {
  const visitNote: PendingInteraction = {
    kind: "visit_note",
    choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
  };

  it("maps an exact current label to the stable choice id", () => {
    expect(interpretInteractionReply(visitNote, INTENT_SKIP_LABEL)).toEqual({
      kind: "choice",
      choiceId: "skip",
    });
  });

  it("keeps the same choice id when the visible label changes", () => {
    const englishSkip: PendingInteraction = {
      kind: "visit_note",
      choices: [{ id: "skip", label: "Continue with no comments" }],
    };
    expect(interpretInteractionReply(englishSkip, "Continue with no comments")).toEqual({
      kind: "choice",
      choiceId: "skip",
    });
    expect(interpretInteractionReply(englishSkip, INTENT_SKIP_LABEL)).toEqual({
      kind: "unmatched",
    });
  });

  it("rejects labels that are not on the current interaction", () => {
    expect(interpretInteractionReply(visitNote, "Так")).toEqual({ kind: "unmatched" });
    expect(interpretInteractionReply(null, INTENT_SKIP_LABEL)).toEqual({ kind: "unmatched" });
    expect(interpretInteractionReply(visitNote, "  ")).toEqual({ kind: "unmatched" });
  });
});

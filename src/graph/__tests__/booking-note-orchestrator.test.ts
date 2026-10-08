import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  BOOKING_NOTE_QUESTION_UK,
  INTENT_SKIP_LABEL,
  SERVICE_CHANGE_ACK_UK,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  abandonPendingConfirmAfterOrch,
  bookingTurnNeedsNoteOrchestrator,
  createBookingInteractionRenderNode,
  createBookingNoteOrchestratorNode,
  defaultServiceOrNoteChoices,
  orchestrateBookingNoteTurn,
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
  type ResolveServiceChange,
} from "../booking-note-orchestrator.js";
import type { ClassifyNoteTurn } from "../booking-note-turn.js";
import {
  openVisitNoteInteraction,
  type PendingInteraction,
} from "../pending-interaction.js";

const acceptedSlotDraft = () => {
  const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-botox", name: "Botox", source: "catalog" },
    accepted: true,
  });
  const dated = reduceBookingDraft(accepted, {
    type: "date_selected",
    date: "2026-10-17",
  });
  return reduceBookingDraft(dated, {
    type: "slot_selected",
    slot: {
      dateStart: "2026-10-17T11:30:00",
      dateEnd: "2026-10-17T12:00:00",
      label: "11:30",
    },
  })!;
};

describe("bookingTurnNeedsNoteOrchestrator", () => {
  it("is false after skip while a confirm command is still pending", () => {
    const skipped = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "skipped",
    })!;
    expect(bookingTurnNeedsNoteOrchestrator({
      bookingDraft: {
        ...skipped,
        phase: "confirming",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-botox",
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
          },
        },
      },
      pendingInteraction: null,
    })).toBe(false);
  });

  it("is true while a keep/switch interaction is open", () => {
    expect(bookingTurnNeedsNoteOrchestrator({
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: {
        kind: "service_or_note",
        currentService: { id: "svc-botox", name: "Botox" },
        noteCandidate: "ботокс",
        choices: defaultServiceOrNoteChoices(),
      },
    })).toBe(true);
  });

  it("is true on TIME phase before a slot when a service is accepted", () => {
    const dated = reduceBookingDraft(acceptedSlotDraft(), {
      type: "slot_invalidated",
      keepDate: true,
    })!;
    expect(dated.phase).toBe("time");
    expect(dated.selectedSlot).toBeNull();
    expect(bookingTurnNeedsNoteOrchestrator({
      bookingDraft: dated,
      pendingInteraction: null,
    })).toBe(true);
  });

  it("is true on DATE phase before a slot when a service is accepted", () => {
    const cleared = reduceBookingDraft(acceptedSlotDraft(), {
      type: "slot_invalidated",
      keepDate: false,
    })!;
    expect(cleared.phase).toBe("date");
    expect(bookingTurnNeedsNoteOrchestrator({
      bookingDraft: cleared,
      pendingInteraction: null,
    })).toBe(true);
  });
});

describe("abandonPendingConfirmAfterOrch", () => {
  const confirming = () => {
    const skipped = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "skipped",
    })!;
    return {
      ...skipped,
      phase: "confirming" as const,
      pendingCommand: {
        action: "create" as const,
        payload: {
          serviceId: "svc-botox",
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
        },
      },
    };
  };

  it("keeps the slot when rendering keep/switch", () => {
    const draft = confirming();
    const next = abandonPendingConfirmAfterOrch(draft, "interaction_render");
    expect(next?.pendingCommand).toBeNull();
    expect(next?.selectedSlot).toEqual(draft.selectedSlot);
  });

  it("invalidates the slot when handing schedule change to the booking LLM", () => {
    const next = abandonPendingConfirmAfterOrch(confirming(), "booking_llm");
    expect(next).toMatchObject({
      pendingCommand: null,
      selectedSlot: null,
      selectedDate: "2026-10-17",
    });
  });

  it("is a no-op when the confirm was already cleared", () => {
    const draft = acceptedSlotDraft();
    expect(abandonPendingConfirmAfterOrch(draft, "booking_llm")).toBe(draft);
  });
});

describe("orchestrateBookingNoteTurn", () => {
  it("runs classify → reduce without resolve for note_provided", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "note_provided" }));
    const resolve = vi.fn<ResolveServiceChange>();
    const result = await orchestrateBookingNoteTurn({
      patientText: "хочу ботокс у зоні лоба",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: openVisitNoteInteraction(),
      classify,
      resolveServiceChange: resolve,
    });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "хочу ботокс у зоні лоба",
    });
    expect(result.pendingInteraction).toBeNull();
    expect(result.goto).toBe("command_prepare");
    expect(result.clearAvailability).toBe(false);
  });

  it("opens clarification and routes to render without resolving", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "service_or_note_clarification_required",
      query: "consultation",
    }));
    const resolve = vi.fn<ResolveServiceChange>();
    const result = await orchestrateBookingNoteTurn({
      patientText: "I need a consultation regarding Botox",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: openVisitNoteInteraction(),
      currentServiceName: "Botox",
      classify,
      resolveServiceChange: resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.goto).toBe("interaction_render");
    expect(result.pendingInteraction?.kind).toBe("service_or_note");
    expect(result.pendingInteraction).toMatchObject({
      noteCandidate: "I need a consultation regarding Botox",
      query: "consultation",
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
  });

  it.each([
    "потрібна консультація щодо ювідерм",
    "потрібна консультація щодо збільшення губ",
  ])(
    "UA consultation-about-procedure opens service_or_note, not visit_note re-ask: %s",
    async (patientText) => {
      const juvedermDraft = (() => {
        const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-juvederm", name: "Juvederm", source: "catalog" },
          accepted: true,
        });
        const dated = reduceBookingDraft(accepted, {
          type: "date_selected",
          date: "2026-10-19",
        });
        return reduceBookingDraft(dated, {
          type: "slot_selected",
          slot: {
            dateStart: "2026-10-19T12:00:00",
            dateEnd: "2026-10-19T12:30:00",
            label: "12:00",
          },
        })!;
      })();
      const classify = vi.fn<ClassifyNoteTurn>(async () => ({
        kind: "service_or_note_clarification_required",
        query: "консультація",
      }));
      const result = await orchestrateBookingNoteTurn({
        patientText,
        bookingDraft: juvedermDraft,
        pendingInteraction: openVisitNoteInteraction(),
        currentServiceName: "Juvederm",
        classify,
        resolveServiceChange: vi.fn(),
      });

      expect(result.goto).toBe("interaction_render");
      expect(result.pendingInteraction?.kind).toBe("service_or_note");
      expect(result.pendingInteraction).toMatchObject({
        noteCandidate: patientText,
        currentService: { id: "svc-juvederm", name: "Juvederm" },
      });
      expect(result.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-19T12:00:00");
      expect(result.bookingDraft?.note.status).toBe("awaiting");
      expect(String(renderBookingInteractionMessage(result.pendingInteraction!).content))
        .not.toContain("деталями");
    },
  );

  it("Consultation + procedure wish opens keep/switch, not catalog candidate list", async () => {
    const patientText = "хочу зробити збільшення губ";
    const consultationDraft = (() => {
      const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
        type: "service_selected",
        service: { id: "svc-consult", name: "Консультація", source: "catalog" },
        accepted: true,
      });
      const dated = reduceBookingDraft(accepted, {
        type: "date_selected",
        date: "2026-10-20",
      });
      return reduceBookingDraft(dated, {
        type: "slot_selected",
        slot: {
          dateStart: "2026-10-20T12:00:00",
          dateEnd: "2026-10-20T12:30:00",
          label: "12:00",
        },
      })!;
    })();
    const resolve = vi.fn<ResolveServiceChange>();
    const result = await orchestrateBookingNoteTurn({
      patientText,
      bookingDraft: consultationDraft,
      pendingInteraction: openVisitNoteInteraction(),
      currentServiceName: "Консультація",
      classify: async () => ({
        kind: "service_or_note_clarification_required",
        query: "збільшення губ",
      }),
      resolveServiceChange: resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.goto).toBe("interaction_render");
    expect(result.pendingInteraction?.kind).toBe("service_or_note");
    expect(result.pendingInteraction).toMatchObject({
      noteCandidate: patientText,
      currentService: { id: "svc-consult", name: "Консультація" },
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-consult");
    expect(result.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-20T12:00:00");
    const body = String(renderBookingInteractionMessage(result.pendingInteraction!).content);
    expect(body).toContain("Консультація");
    expect(body).toContain("• Продовжити з обраною послугою");
    expect(body).toContain("• Змінити послугу");
    expect(body).toMatch(/\?/);
    expect(body).not.toContain("послугу зі списку");
    expect(body).not.toContain("деталями");
    expect(replyButtonsForInteraction(result.pendingInteraction!)).toEqual([
      "Продовжити з обраною послугою",
      "Змінити послугу",
    ]);
  });

  it("switch_service runs resolve then a second reduction", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const resolve = vi.fn<ResolveServiceChange>(async (effect) => ({
      type: "service_changed",
      service: {
        id: "svc-consult",
        name: "Консультація",
        source: "catalog",
      },
      accepted: true,
      ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
    }));
    const interaction: PendingInteraction = {
      kind: "service_or_note",
      currentService: { id: "svc-botox", name: "Botox" },
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    };
    const result = await orchestrateBookingNoteTurn({
      patientText: "Switch",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: interaction,
      classify,
      resolveServiceChange: resolve,
    });

    expect(classify).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      type: "resolve_service",
      utterance: "I need a consultation regarding Botox",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
    });
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-consult");
    expect(result.bookingDraft?.note).toEqual({ status: "unasked" });
    expect(result.bookingDraft?.selectedSlot).toBeNull();
    expect(result.clearAvailability).toBe(true);
    expect(result.goto).toBe("command_prepare");
    expect(result.serviceChangeNotice).toBe(serviceChangedNoticeUk("Консультація"));
  });

  it("keep_service answers the note and continues to command prepare", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const resolve = vi.fn<ResolveServiceChange>();
    const interaction: PendingInteraction = {
      kind: "service_or_note",
      currentService: { id: "svc-botox", name: "Botox" },
      noteCandidate: "I need a consultation regarding Botox",
      choices: [
        { id: "keep_service", label: "Keep Botox" },
        { id: "switch_service", label: "Switch" },
      ],
    };
    const result = await orchestrateBookingNoteTurn({
      patientText: "Keep Botox",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: interaction,
      classify,
      resolveServiceChange: resolve,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(result.bookingDraft?.note).toEqual({
      status: "answered",
      value: "I need a consultation regarding Botox",
    });
    expect(result.goto).toBe("command_prepare");
  });

  it("unresolved re-asks via interaction_render", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "unresolved" }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "???",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: openVisitNoteInteraction(),
      classify,
      resolveServiceChange: vi.fn(),
    });

    expect(result.goto).toBe("interaction_render");
    expect(result.bookingDraft?.note.status).toBe("awaiting");
    expect(result.pendingInteraction?.kind).toBe("visit_note");
  });

  it("schedule_change_requested clears the slot and goes to booking_llm", async () => {
    const skipped = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "skipped",
    });
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "schedule_change_requested",
    }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "А можна інший час?",
      bookingDraft: skipped,
      pendingInteraction: null,
      classify,
      resolveServiceChange: vi.fn(),
    });

    expect(result.goto).toBe("booking_llm");
    expect(result.pendingInteraction).toBeNull();
    expect(result.bookingDraft).toMatchObject({
      note: { status: "skipped" },
      selectedSlot: null,
      selectedDate: "2026-10-17",
    });
  });

  it("unresolved after skip does not reopen visit_note", async () => {
    const skipped = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "skipped",
    });
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "unresolved" }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "???",
      bookingDraft: skipped,
      pendingInteraction: null,
      classify,
      resolveServiceChange: vi.fn(),
    });

    expect(result.goto).toBe("booking_llm");
    expect(result.pendingInteraction).toBeNull();
  });

  it("unresolved on TIME before a slot does not open visit_note", async () => {
    const timeDraft = reduceBookingDraft(acceptedSlotDraft(), {
      type: "slot_invalidated",
      keepDate: true,
    });
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "unresolved" }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "???",
      bookingDraft: timeDraft,
      pendingInteraction: null,
      classify,
      resolveServiceChange: vi.fn(),
    });

    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ draftPhase: "time" }));
    expect(result.goto).toBe("booking_llm");
    expect(result.pendingInteraction).toBeNull();
  });

  it("note_provided on TIME before a slot does not open visit_note", async () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-botox", name: "Botox", source: "catalog" },
      accepted: true,
    });
    const timeDraft = reduceBookingDraft(accepted, {
      type: "date_selected",
      date: "2026-10-19",
    });
    expect(timeDraft?.phase).toBe("time");
    expect(timeDraft?.note.status).toBe("unasked");
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "note_provided" }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "лоб",
      bookingDraft: timeDraft,
      pendingInteraction: null,
      classify,
      resolveServiceChange: vi.fn(),
    });

    expect(result.goto).toBe("booking_llm");
    expect(result.pendingInteraction).toBeNull();
    expect(result.bookingDraft?.note.status).toBe("unasked");
  });

  it("routes service_unresolved to faq while preserving the draft", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "service_change_requested",
      query: "unknown",
    }));
    const resolve = vi.fn<ResolveServiceChange>(async () => ({ type: "service_unresolved" }));
    const result = await orchestrateBookingNoteTurn({
      patientText: "запиши на unknown",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: openVisitNoteInteraction(),
      classify,
      resolveServiceChange: resolve,
    });

    expect(result.goto).toBe("faq_prepare");
    expect(result.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-botox");
    expect(result.pendingInteraction?.choices.some((c) => c.id === "return_to_booking")).toBe(true);
  });
});

describe("renderBookingInteractionMessage", () => {
  it("writes a fresh AIMessage from the open interaction", () => {
    const message = renderBookingInteractionMessage({
      kind: "visit_note",
      choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
    });
    expect(message).toBeInstanceOf(AIMessage);
    expect(String(message.content)).toBe(BOOKING_NOTE_QUESTION_UK);
    expect(String(message.content)).not.toContain("• Продовжити без коментаря");
    expect(String(message.content)).not.toContain("Який варіант вам підходить?");
    expect(replyButtonsForInteraction({
      kind: "visit_note",
      choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
    })).toEqual([INTENT_SKIP_LABEL]);
  });

  it("does not reuse a stale assistant message", () => {
    const stale = new AIMessage("stale body from last turn");
    const message = renderBookingInteractionMessage(
      {
        kind: "service_or_note",
        currentService: { id: "svc-1", name: "Botox" },
        noteCandidate: "mixed",
        choices: [
          { id: "keep_service", label: "Keep" },
          { id: "switch_service", label: "Switch" },
        ],
      },
      { staleMessages: [stale, new HumanMessage("Switch")] },
    );
    expect(String(message.content)).not.toContain("stale body");
    expect(String(message.content)).toContain("Botox");
    expect(String(message.content)).toContain("• Keep");
    expect(String(message.content)).toContain("• Switch");
  });

  it("templates service_candidate with a service-change acknowledgement and FAQ-shaped bullets", () => {
    const message = renderBookingInteractionMessage({
      kind: "service_candidate",
      utterance: "ботокс",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "svc-b", label: "шия", serviceIds: ["svc-b"] },
      ],
    });
    const body = String(message.content);
    expect(body).toContain(SERVICE_CHANGE_ACK_UK);
    expect(body).toContain("• обличчя");
    expect(body).toContain("• шия");
    expect(body).toMatch(/\?/);
    expect(body).not.toContain("послугу зі списку");
    expect(replyButtonsForInteraction({
      kind: "service_candidate",
      utterance: "ботокс",
      choices: [
        { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
        { id: "svc-b", label: "шия", serviceIds: ["svc-b"] },
      ],
    })).toEqual(["обличчя", "шия"]);
  });

  it("narrows a multi-id group then applies the last singleton without FAQ handoff", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const resolve = vi.fn<ResolveServiceChange>(async (effect) => {
      if (effect.remainingIds?.length === 2) {
        return {
          type: "service_candidates_opened",
          utterance: effect.utterance,
          ...(effect.noteCandidate != null ? { noteCandidate: effect.noteCandidate } : {}),
          choices: [
            { id: "svc-a", label: "обличчя", serviceIds: ["svc-a"] },
            { id: "svc-b", label: "шия", serviceIds: ["svc-b"] },
          ],
        };
      }
      throw new Error(`unexpected resolve: ${JSON.stringify(effect)}`);
    });
    const interaction: PendingInteraction = {
      kind: "service_candidate",
      utterance: "ботокс",
      noteCandidate: "note text",
      choices: [
        {
          id: "g0",
          label: "ботулінотерапія",
          serviceIds: ["svc-a", "svc-b"],
        },
      ],
    };
    const narrowed = await orchestrateBookingNoteTurn({
      patientText: "ботулінотерапія",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: interaction,
      classify,
      resolveServiceChange: resolve,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      type: "resolve_service",
      utterance: "ботокс",
      noteCandidate: "note text",
      remainingIds: ["svc-a", "svc-b"],
    });
    expect(narrowed.goto).toBe("interaction_render");
    expect(narrowed.pendingInteraction?.kind).toBe("service_candidate");
    expect(String(renderBookingInteractionMessage(narrowed.pendingInteraction!).content))
      .toContain("• обличчя");

    const applyResolve = vi.fn<ResolveServiceChange>(async () => ({
      type: "service_changed",
      service: { id: "svc-a", name: "Botox Face", source: "catalog" },
      accepted: true,
      noteCandidate: "note text",
    }));
    const applied = await orchestrateBookingNoteTurn({
      patientText: "обличчя",
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: narrowed.pendingInteraction,
      classify,
      resolveServiceChange: applyResolve,
    });
    expect(applyResolve).toHaveBeenCalledWith({
      type: "resolve_service",
      utterance: "обличчя",
      query: "svc-a",
      noteCandidate: "note text",
    });
    expect(applied.goto).toBe("command_prepare");
    expect(applied.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-a");
    expect(applied.bookingDraft?.note).toEqual({ status: "unasked" });
    expect(applied.bookingDraft?.selectedSlot).toBeNull();
    expect(applied.bookingDraft?.selectedDate).toBeNull();
    expect(applied.clearAvailability).toBe(true);
    expect(applied.serviceChangeNotice).toBe(serviceChangedNoticeUk("Botox Face"));
  });

  it("note-orch node publishes the service-change notice and clears stale availability", async () => {
    const node = createBookingNoteOrchestratorNode({
      classify: async () => ({ kind: "service_change_requested", query: "neotiva" }),
      resolveServiceChange: async () => ({
        type: "service_changed",
        service: {
          id: "svc-neotiva",
          name: "Збільшення губ Neotiva",
          durationMinutes: 60,
          source: "catalog",
        },
        accepted: true,
      }),
      nodes: {
        bookingLlm: "booking__llm",
        commandPrepare: "booking__command_prepare",
        interactionRender: "booking__interaction_render",
        faqPrepare: "faq__prepare",
      },
    });
    const command = await node({
      messages: [new HumanMessage("запиши на збільшення губ")],
      bookingDraft: acceptedSlotDraft(),
      pendingInteraction: openVisitNoteInteraction(),
      availabilityContext: {
        days: [{
          date: "2026-10-17",
          slots: [{
            id: "s1",
            label: "11:30",
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
          }],
        }],
        stepMinutes: 30,
      },
    } as never);

    expect(command.goto).toEqual(["booking__command_prepare"]);
    expect(command.update.serviceChangeNotice).toBe(
      serviceChangedNoticeUk("Збільшення губ Neotiva"),
    );
    expect(command.update.availabilityContext).toBeNull();
    expect(command.update.bookingDraft?.selectedSlot).toBeNull();
    expect(command.update.bookingDraft?.phase).toBe("date");
  });

  it("open keep/switch with a stale confirm clears pendingCommand and keeps the slot", async () => {
    const skipped = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "skipped",
    })!;
    const confirming = {
      ...skipped,
      phase: "confirming" as const,
      pendingCommand: {
        action: "create" as const,
        payload: {
          serviceId: "svc-botox",
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
        },
      },
    };
    const interaction: PendingInteraction = {
      kind: "service_or_note",
      currentService: { id: "svc-botox", name: "Botox" },
      noteCandidate: "запиши на ботокс",
      choices: defaultServiceOrNoteChoices(),
    };
    const node = createBookingNoteOrchestratorNode({
      classify: vi.fn(),
      resolveServiceChange: vi.fn(),
      nodes: {
        bookingLlm: "booking__llm",
        commandPrepare: "booking__command_prepare",
        interactionRender: "booking__interaction_render",
        faqPrepare: "faq__prepare",
      },
    });
    const command = await node({
      messages: [new HumanMessage("Продовжити з обраною послугою")],
      bookingDraft: confirming,
      pendingInteraction: interaction,
    } as never);

    expect(command.goto).toEqual(["booking__command_prepare"]);
    expect(command.update.pendingInteraction).toBeNull();
    expect(command.update.bookingDraft?.pendingCommand).toBeNull();
    expect(command.update.bookingDraft?.selectedSlot).toEqual(confirming.selectedSlot);
  });

  it("schedule_change with a stale confirm invalidates the slot via abandon", async () => {
    const awaiting = reduceBookingDraft(acceptedSlotDraft(), {
      type: "note_status",
      status: "awaiting",
    })!;
    const confirming = {
      ...awaiting,
      phase: "confirming" as const,
      pendingCommand: {
        action: "create" as const,
        payload: { serviceId: "svc-botox" },
      },
    };
    const node = createBookingNoteOrchestratorNode({
      classify: async () => ({ kind: "schedule_change_requested" }),
      resolveServiceChange: vi.fn(),
      nodes: {
        bookingLlm: "booking__llm",
        commandPrepare: "booking__command_prepare",
        interactionRender: "booking__interaction_render",
        faqPrepare: "faq__prepare",
      },
    });
    const command = await node({
      messages: [new HumanMessage("А можна інший час?")],
      bookingDraft: confirming,
      pendingInteraction: openVisitNoteInteraction(),
    } as never);

    expect(command.goto).toEqual(["booking__llm"]);
    expect(command.update.bookingDraft).toMatchObject({
      pendingCommand: null,
      selectedSlot: null,
      selectedDate: "2026-10-17",
    });
  });

  it("interaction_render lastHandoff lists keep/switch in text and on the keyboard", () => {
    const render = createBookingInteractionRenderNode({ id: "booking", name: "Booking" });
    const choices = defaultServiceOrNoteChoices();
    const update = render({
      messages: [],
      agentMessages: [],
      pendingInteraction: {
        kind: "service_or_note",
        currentService: { id: "svc-consult", name: "Консультація" },
        noteCandidate: "запиши на ботокс",
        choices,
      },
    } as never);
    const text = String((update.lastHandoff as { replyText: string }).replyText);
    expect(text).toContain("• Продовжити з обраною послугою");
    expect(text).toContain("• Змінити послугу");
    expect((update.lastHandoff as { replyButtons: string[] }).replyButtons).toEqual([
      "Продовжити з обраною послугою",
      "Змінити послугу",
    ]);
  });
});

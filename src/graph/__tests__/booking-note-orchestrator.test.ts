import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { INTENT_SKIP_LABEL } from "../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  orchestrateBookingNoteTurn,
  renderBookingInteractionMessage,
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
    expect(result.bookingDraft?.note.value).toBe("I need a consultation regarding Botox");
    expect(result.clearAvailability).toBe(true);
    expect(result.goto).toBe("booking_llm");
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
    expect(String(message.content)).toContain("деталями");
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
  });
});

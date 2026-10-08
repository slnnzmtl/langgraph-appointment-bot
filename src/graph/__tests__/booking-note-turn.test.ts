import { describe, expect, it, vi } from "vitest";

import { INTENT_SKIP_LABEL, MAIN_MENU_LABEL } from "../../shared/clinic-constants.js";
import {
  interpretNoteTurn,
  noteTurnClassificationSchema,
  sessionEventFromClassification,
  type ClassifyNoteTurn,
  type NoteTurnClassification,
} from "../booking-note-turn.js";
import type { PendingInteraction } from "../booking-session.js";

const visitNote: PendingInteraction = {
  kind: "visit_note",
  choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
};

const clarification: PendingInteraction = {
  kind: "service_or_note",
  currentService: { id: "svc-botox", name: "Botox" },
  query: "consultation",
  noteCandidate: "I need a consultation regarding Botox",
  choices: [
    { id: "keep_service", label: "Keep Botox as the visit" },
    { id: "switch_service", label: "Switch to Consultation" },
  ],
};

describe("interpretNoteTurn trusted path", () => {
  it("matches a snapshotted choice label to interaction_choice without classifying", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const result = await interpretNoteTurn({
      patientText: INTENT_SKIP_LABEL,
      pendingInteraction: visitNote,
      classify,
    });

    expect(result).toEqual({
      source: "trusted",
      sessionEvent: { type: "interaction_choice", choiceId: "skip" },
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("matches clarification labels by stored text, not by default copy", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const result = await interpretNoteTurn({
      patientText: "Keep Botox as the visit",
      pendingInteraction: clarification,
      classify,
    });

    expect(result).toEqual({
      source: "trusted",
      sessionEvent: { type: "interaction_choice", choiceId: "keep_service" },
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("maps the main-menu label to leave_booking without classifying", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const result = await interpretNoteTurn({
      patientText: MAIN_MENU_LABEL,
      pendingInteraction: visitNote,
      classify,
    });

    expect(result).toEqual({
      source: "trusted",
      sessionEvent: { type: "leave_booking", destination: "main_menu" },
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("accepts a schedule match from the injected snapshot matcher", async () => {
    const classify = vi.fn<ClassifyNoteTurn>();
    const result = await interpretNoteTurn({
      patientText: "14:00",
      pendingInteraction: visitNote,
      matchSchedule: (text) =>
        text === "14:00"
          ? {
              type: "slot_selected",
              slot: {
                dateStart: "2026-10-17T14:00:00",
                dateEnd: "2026-10-17T14:30:00",
                label: "14:00",
              },
            }
          : null,
      classify,
    });

    expect(result.source).toBe("trusted");
    if (result.source === "trusted") {
      expect(result.sessionEvent.type).toBe("slot_selected");
    }
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("interpretNoteTurn classifier path", () => {
  it("routes skip synonyms through the classifier once", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "note_skipped" }));
    for (const synonym of ["ні", "skip", "без коментаря", "no"]) {
      classify.mockClear();
      const result = await interpretNoteTurn({
        patientText: synonym,
        pendingInteraction: visitNote,
        classify,
      });
      expect(result).toEqual({
        source: "classified",
        classification: { kind: "note_skipped" },
      });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(classify).toHaveBeenCalledWith({
        patientText: synonym,
        currentServiceName: undefined,
      });
    }
  });

  it("returns classifier kind and optional query without a note value", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "service_or_note_clarification_required",
      query: "consultation",
    }));
    const result = await interpretNoteTurn({
      patientText: "I need a consultation regarding Botox",
      pendingInteraction: visitNote,
      currentServiceName: "Botox",
      classify,
    });

    expect(result).toEqual({
      source: "classified",
      classification: {
        kind: "service_or_note_clarification_required",
        query: "consultation",
      },
    });
    const parsed = noteTurnClassificationSchema.safeParse(
      (result as { classification: NoteTurnClassification }).classification,
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("noteCandidate");
    expect(parsed.data).not.toHaveProperty("value");
  });

  it("maps explicit service change to service_change_requested with query only", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "service_change_requested",
      query: "ботокс",
    }));
    const result = await interpretNoteTurn({
      patientText: "запиши мене на ботокс",
      pendingInteraction: visitNote,
      currentServiceName: "Консультація",
      classify,
    });

    expect(result).toEqual({
      source: "classified",
      classification: { kind: "service_change_requested", query: "ботокс" },
    });
  });

  it("maps an ordinary note to note_provided without rewriting text", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "note_provided" }));
    const result = await interpretNoteTurn({
      patientText: "хочу ботокс у зоні лоба",
      pendingInteraction: visitNote,
      currentServiceName: "Консультація",
      classify,
    });

    expect(result).toEqual({
      source: "classified",
      classification: { kind: "note_provided" },
    });
  });

  it("treats invalid classifier output as unresolved", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({
      kind: "invented_kind",
    }) as unknown as NoteTurnClassification);
    const result = await interpretNoteTurn({
      patientText: "whatever",
      pendingInteraction: visitNote,
      classify,
    });

    expect(result).toEqual({
      source: "classified",
      classification: { kind: "unresolved" },
    });
  });

  it("invokes the free-text classifier at most once per message", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "note_provided" }));
    await interpretNoteTurn({
      patientText: "some free text",
      pendingInteraction: visitNote,
      classify,
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("rejects a classifier leave_booking that is not a stable menu label", async () => {
    const classify = vi.fn<ClassifyNoteTurn>(async () => ({ kind: "leave_booking" }));
    const result = await interpretNoteTurn({
      patientText: "I changed my mind about booking",
      pendingInteraction: visitNote,
      classify,
    });

    expect(result).toEqual({
      source: "classified",
      classification: { kind: "unresolved" },
    });
  });
});

describe("sessionEventFromClassification", () => {
  it("assigns noteCandidate and note value from the original patient text", () => {
    expect(
      sessionEventFromClassification(
        { kind: "note_provided" },
        "хочу ботокс у зоні лоба",
      ),
    ).toEqual({ type: "note_provided", value: "хочу ботокс у зоні лоба" });
    expect(
      sessionEventFromClassification(
        { kind: "service_or_note_clarification_required", query: "consultation" },
        "I need a consultation regarding Botox",
      ),
    ).toEqual({
      type: "service_or_note_opened",
      query: "consultation",
      noteCandidate: "I need a consultation regarding Botox",
      choices: [],
    });
    expect(
      sessionEventFromClassification(
        { kind: "service_change_requested", query: "ботокс" },
        "запиши на ботокс",
      ),
    ).toEqual({
      type: "service_change_requested",
      utterance: "запиши на ботокс",
      query: "ботокс",
    });
    expect(
      sessionEventFromClassification(
        { kind: "schedule_change_requested" },
        "А можна інший час?",
      ),
    ).toEqual({ type: "schedule_change_requested" });
    expect(
      sessionEventFromClassification({ kind: "unresolved" }, "???"),
    ).toEqual({ type: "unresolved" });
  });
});

describe("noteTurnClassificationSchema", () => {
  it("accepts only allowed kinds and an optional query string", () => {
    expect(noteTurnClassificationSchema.parse({ kind: "note_skipped" })).toEqual({
      kind: "note_skipped",
    });
    expect(
      noteTurnClassificationSchema.parse({
        kind: "service_change_requested",
        query: "ботокс",
      }),
    ).toEqual({ kind: "service_change_requested", query: "ботокс" });
    expect(() =>
      noteTurnClassificationSchema.parse({
        kind: "note_provided",
        value: "should not be here",
      }),
    ).toThrow();
  });
});

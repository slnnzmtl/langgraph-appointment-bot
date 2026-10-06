import { describe, expect, it } from "vitest";

import { NOTE_TURN_CLASSIFIER_INSTRUCTION } from "../booking-note-classifier.js";

describe("NOTE_TURN_CLASSIFIER_INSTRUCTION", () => {
  it("teaches mixed vs replace vs note without command/phrase/catalog token lists", () => {
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "service_or_note_clarification_required",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain("service_change_requested");
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain("note_provided");
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "replacing which service this visit is for",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "locates a treatment or concern on the body",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "even when the treatment name differs from the selected service",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "does not locate that treatment on the body",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "Do not use command-phrase lists",
    );
    // No UA/EN command templates, skip synonyms, stems, or catalog brands.
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/запиши на/i);
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/хочу .+ у зоні/i);
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/book me for/i);
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/ботокс|juvederm|лазер|пілінг/i);
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/«консультація»/i);
  });
});

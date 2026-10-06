import { describe, expect, it } from "vitest";

import { NOTE_TURN_CLASSIFIER_INSTRUCTION } from "../booking-note-classifier.js";

describe("NOTE_TURN_CLASSIFIER_INSTRUCTION", () => {
  it("teaches mixed consultation-about-procedure vs area notes vs explicit book", () => {
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "service_or_note_clarification_required",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain("запиши на X");
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain("хочу X у зоні Y");
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).toContain(
      "consultation about that procedure",
    );
    expect(NOTE_TURN_CLASSIFIER_INSTRUCTION).not.toMatch(/ботокс/i);
  });
});

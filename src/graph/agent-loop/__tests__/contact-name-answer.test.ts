import { describe, expect, it } from "vitest";

import { looksLikeContactNameAnswer } from "../contact-name-answer.js";

describe("looksLikeContactNameAnswer", () => {
  it("accepts short Cyrillic and Latin names", () => {
    expect(looksLikeContactNameAnswer("Олена")).toBe(true);
    expect(looksLikeContactNameAnswer("Smoke Tester")).toBe(true);
    expect(looksLikeContactNameAnswer("Mary-Jane")).toBe(true);
  });

  it("rejects phones, questions, and ramble", () => {
    expect(looksLikeContactNameAnswer("+380501112233")).toBe(false);
    expect(looksLikeContactNameAnswer("а скільки коштує?")).toBe(false);
    expect(looksLikeContactNameAnswer("")).toBe(false);
    expect(looksLikeContactNameAnswer("one two three four")).toBe(false);
  });
});

import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  detectLocaleFromPatientText,
  nextPatientLocale,
  resolvePatientLocale,
} from "../conversation-locale.js";

describe("conversation locale", () => {
  it("ignores numeric-only replies for detection", () => {
    expect(detectLocaleFromPatientText("+380501112233")).toBeNull();
    expect(detectLocaleFromPatientText("0501112233")).toBeNull();
    expect(nextPatientLocale("en", "+380501112233")).toBe("en");
    expect(nextPatientLocale("uk", "0501112233")).toBe("uk");
  });

  it("allows an explicit later language change", () => {
    expect(nextPatientLocale("uk", "I want to book")).toBe("en");
    expect(nextPatientLocale("en", "Хочу записатись")).toBe("uk");
  });

  it("keeps session locale after a phone reply in resolvePatientLocale", () => {
    expect(
      resolvePatientLocale({
        patientLocale: "en",
        messages: [
          new HumanMessage("I want Botox tomorrow"),
          new HumanMessage("+380501112233"),
        ],
      }),
    ).toBe("en");
  });
});

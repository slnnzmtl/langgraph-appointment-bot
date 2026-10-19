import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  allowlistedInformationalFacts,
  effectResultFromToolMessages,
} from "../booking-decide-nodes.js";

describe("allowlisted informational facts", () => {
  it("keeps only hours/address/servicePrice and drops raw text keys", () => {
    const facts = allowlistedInformationalFacts({
      hours: "Пн–Пт 09:00–18:00",
      address: "вул. Прикладна 1",
      servicePrice: "1200",
      secretPatientNote: "do not leak",
      rawDump: "full tool body",
    });
    expect(facts).toEqual({
      hours: "Пн–Пт 09:00–18:00",
      address: "вул. Прикладна 1",
      servicePrice: "1200",
    });
    expect(facts).not.toHaveProperty("secretPatientNote");
    expect(facts).not.toHaveProperty("rawDump");
  });

  it("maps get_working_time tool JSON into allowlisted facts without raw body", () => {
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            hours: "09:00-18:00",
            address: "Kyiv",
            internalTrace: "PII-or-prompt",
          }),
          tool_call_id: "eff_1_get_working_time",
          name: "get_working_time",
        }),
      ],
      {
        id: "eff_1_get_working_time",
        expectedRevision: 1,
        effect: { kind: "get_working_time" },
        status: "prepared",
      },
    );
    expect(result).toMatchObject({
      kind: "informational",
      outcome: "ok",
      facts: { hours: "09:00-18:00", address: "Kyiv" },
    });
    expect(JSON.stringify(result)).not.toContain("internalTrace");
    expect(JSON.stringify(result)).not.toContain("PII-or-prompt");
  });
});

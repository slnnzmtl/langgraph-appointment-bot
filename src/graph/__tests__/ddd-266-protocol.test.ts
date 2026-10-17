import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { sanitizeBoundModelToolCalls } from "../agent-loop/tool-call-coercion.js";
import { resolveCatalogFreeText } from "../catalog-match.js";

describe("DDD-266 model control protocols", () => {
  it("strips leaked tool markup without adding tool_calls", () => {
    const informational = new Set(["list_services"]);
    const coerced = sanitizeBoundModelToolCalls(
      new AIMessage(
        "Hi <call:default_api:create_meeting{confirmationGiven: true}></call:default_api:create_meeting>",
      ),
      informational,
    );
    expect(coerced.tool_calls ?? []).toEqual([]);
    expect(String(coerced.content)).not.toContain("<call:");
  });
});

describe("DDD-266 catalog resolution order", () => {
  const rows = [
    { id: "svc-a", name: "Neotiva", duration: 30 },
    { id: "svc-b", name: "Botox Full Face", duration: 30 },
  ];

  it("resolves an exact CRM title without calling selectCandidates", async () => {
    const selectCandidates = vi.fn();
    const result = await resolveCatalogFreeText({
      text: "Neotiva",
      rows,
      selectCandidates,
    });
    expect(result).toEqual({ kind: "one", row: rows[0] });
    expect(selectCandidates).not.toHaveBeenCalled();
  });

  it("returns none without lexical stems and without selectCandidates", async () => {
    const result = await resolveCatalogFreeText({
      text: "how much does it cost",
      rows,
    });
    expect(result).toEqual({ kind: "none" });
  });
});

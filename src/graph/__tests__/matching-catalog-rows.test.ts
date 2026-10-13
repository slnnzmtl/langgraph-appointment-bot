import { describe, expect, it } from "vitest";

import {
  matchingCatalogRows,
  resolveCatalogFreeText,
  resolveCatalogLexicalEvidence,
} from "../agent-loop/shared.js";

const catalog = [
  {
    id: "svc-collagen",
    name: "Колагеностимуляція Полімолочна кислота",
    duration: 60,
  },
  {
    id: "svc-botox",
    name: "Ботулінотерапія Botox, Disport 1 зона",
    duration: 30,
  },
  {
    id: "svc-corr",
    name: "Корекція ботокс",
    duration: 30,
  },
  {
    id: "svc-consult",
    name: "Консультація первинна",
    duration: 30,
  },
];

describe("matchingCatalogRows", () => {
  it("matches collagen after book-intent and doubled-letter typo via stems", () => {
    const rows = matchingCatalogRows("запиши на коллаген", catalog);
    expect(rows.map((row) => row.id)).toEqual(["svc-collagen"]);
  });

  it("matches collagen after bare negation + book-intent via stems", () => {
    const rows = matchingCatalogRows(
      "ні, запиши на колагеностимуляцію",
      catalog,
    );
    expect(rows.map((row) => row.id)).toEqual(["svc-collagen"]);
  });

  it("keeps substring matches for full CRM names", () => {
    const rows = matchingCatalogRows(
      "Ботулінотерапія Botox, Disport 1 зона",
      catalog,
    );
    expect(rows.map((row) => row.id)).toEqual(["svc-botox"]);
  });

  it("does not match short tokens or questions", () => {
    expect(matchingCatalogRows("ні", catalog)).toEqual([]);
    expect(matchingCatalogRows("да", catalog)).toEqual([]);
    expect(matchingCatalogRows("що це?", catalog)).toEqual([]);
    expect(matchingCatalogRows("можна записатись на ботокс?", catalog)).toEqual([]);
  });
});

describe("resolveCatalogLexicalEvidence", () => {
  it("finds CRM rows when terminal ? is opted in", () => {
    const evidence = resolveCatalogLexicalEvidence(
      "можна записатись на ботокс?",
      catalog,
      { allowTerminalQuestion: true },
    );
    expect(evidence.matcher).toBe("можна записатись на ботокс");
    expect(evidence.matcher.endsWith("?")).toBe(false);
    expect(evidence.rows.map((row) => row.id)).toContain("svc-corr");
  });

  it("returns no rows for terminal ? without opt-in", () => {
    const evidence = resolveCatalogLexicalEvidence(
      "можна записатись на ботокс?",
      catalog,
    );
    expect(evidence.matcher).toBe("можна записатись на ботокс?");
    expect(evidence.rows).toEqual([]);
  });

  it("rejects embedded ? even with terminal opt-in", () => {
    const evidence = resolveCatalogLexicalEvidence(
      "ботокс? чи колаген",
      catalog,
      { allowTerminalQuestion: true },
    );
    expect(evidence.matcher).toContain("?");
    expect(evidence.rows).toEqual([]);
  });

  it("can produce lexical evidence for a terminal price question when opted in", () => {
    const evidence = resolveCatalogLexicalEvidence(
      "Скільки коштує ботокс?",
      catalog,
      { allowTerminalQuestion: true },
    );
    expect(evidence.matcher).toBe("Скільки коштує ботокс");
    expect(evidence.rows.length).toBeGreaterThan(0);
    expect(evidence.rows.map((row) => row.id)).toContain("svc-corr");
  });
});

describe("resolveCatalogFreeText label guards", () => {
  it("rejects keyboard / supervisor / choose_other / FAQ guide labels", async () => {
    for (const text of [
      "Записатись",
      "Послуги",
      "Головне меню",
      "Обрати іншу процедуру",
      "ні",
      "Services",
    ]) {
      const resolved = await resolveCatalogFreeText({
        text,
        rows: catalog,
        allowTerminalQuestion: true,
      });
      expect(resolved, text).toEqual({ kind: "none" });
    }
  });
});

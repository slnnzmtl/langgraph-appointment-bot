import { describe, expect, it } from "vitest";

import {
  foldCatalogScript,
  matchingCatalogRows,
  resolveCatalogFreeText,
  resolveCatalogLexicalEvidence,
} from "../catalog-match.js";

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

const nabotaCatalog = [
  {
    id: "n1",
    name: "Ботулінотерапія Nabota 1 зона",
    duration: 30,
  },
  {
    id: "n2",
    name: "Ботулінотерапія Nabota 2 зони",
    duration: 30,
  },
  {
    id: "n3",
    name: "Ботулінотерапія Nabota 3 зони",
    duration: 45,
  },
  {
    id: "d1",
    name: "Ботулінотерапія Botox, Disport 1 зона",
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

  it("may stem-match «Записатись» to CRM titles starting with запис", () => {
    const rows = matchingCatalogRows("Записатись", [
      { id: "svc-zapis", name: "Запис консультації", duration: 30 },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["svc-zapis"]);
  });

  it("folds Cyrillic brand spellings onto Latin CRM titles", () => {
    expect(foldCatalogScript("набота")).toBe("nabota");
    expect(foldCatalogScript("Nabota".toLocaleLowerCase())).toBe("nabota");
    expect(matchingCatalogRows("набота", nabotaCatalog).map((row) => row.id))
      .toEqual(["n1", "n2", "n3"]);
    expect(matchingCatalogRows("NABOTA", nabotaCatalog).map((row) => row.id))
      .toEqual(["n1", "n2", "n3"]);
    expect(
      matchingCatalogRows("набота 3 зони", nabotaCatalog).map((row) => row.id),
    ).toContain("n3");
  });

  it("does not invent matches for unrelated folded tokens", () => {
    expect(matchingCatalogRows("мезотерапія", nabotaCatalog)).toEqual([]);
    expect(matchingCatalogRows("ліполітики", nabotaCatalog)).toEqual([]);
  });

  it("keeps exact CRM-title equality for a unique row without folding siblings away", async () => {
    const alone = [
      {
        id: "n3",
        name: "Ботулінотерапія Nabota 3 зони",
        duration: 45,
      },
    ];
    const rows = matchingCatalogRows("Ботулінотерапія Nabota 3 зони", alone);
    expect(rows.map((row) => row.id)).toEqual(["n3"]);
    const resolved = await resolveCatalogFreeText({
      text: "Ботулінотерапія Nabota 3 зони",
      rows: alone,
    });
    expect(resolved).toEqual({ kind: "one", row: alone[0] });
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

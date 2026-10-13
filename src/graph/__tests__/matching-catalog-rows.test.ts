import { describe, expect, it } from "vitest";

import { matchingCatalogRows } from "../agent-loop/shared.js";

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
  });
});

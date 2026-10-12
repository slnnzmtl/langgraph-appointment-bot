import { describe, expect, it } from "vitest";

import {
  matchingCatalogRows,
  normalizeCatalogUtterance,
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
    id: "svc-consult",
    name: "Консультація первинна",
    duration: 30,
  },
];

describe("normalizeCatalogUtterance", () => {
  it.each([
    ["запиши на коллаген", "коллаген"],
    ["ні, запиши на колагеностимуляцію", "колагеностимуляцію"],
    ["НІ, запиши на колагеностимуляцію", "колагеностимуляцію"],
    ["хочу на ботокс", "ботокс"],
    ["book me for botox", "botox"],
    ["не треба ботокс", "ботокс"],
  ])("strips lead-ins from %j → %j", (input, expected) => {
    expect(normalizeCatalogUtterance(input)).toBe(expected);
  });
});

describe("matchingCatalogRows", () => {
  it("matches collagen after book-intent and doubled-letter typo", () => {
    const rows = matchingCatalogRows("запиши на коллаген", catalog);
    expect(rows.map((row) => row.id)).toEqual(["svc-collagen"]);
  });

  it("matches collagen after bare negation + book-intent", () => {
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

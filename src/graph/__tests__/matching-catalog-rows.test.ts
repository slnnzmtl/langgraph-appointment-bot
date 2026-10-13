import { describe, expect, it } from "vitest";

import {
  isNamedBookingUtterance,
  matchingCatalogRows,
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

describe("isNamedBookingUtterance", () => {
  it("is true when CRM stems remain beside leftover book tokens", () => {
    expect(isNamedBookingUtterance("запиши на колаген", catalog)).toBe(true);
    expect(isNamedBookingUtterance("запиши на ботокс", catalog)).toBe(true);
    expect(isNamedBookingUtterance("можна записатись на ботокс?", catalog)).toBe(true);
  });

  it("is false for price questions and bare CRM names", () => {
    expect(isNamedBookingUtterance("Скільки коштує ботокс?", catalog)).toBe(false);
    expect(isNamedBookingUtterance("що таке ботокс", catalog)).toBe(false);
    expect(isNamedBookingUtterance("Колагеностимуляція Полімолочна кислота", catalog)).toBe(false);
  });
});

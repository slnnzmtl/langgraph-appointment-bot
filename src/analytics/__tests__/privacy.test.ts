import { describe, expect, it } from "vitest";

import { toPropagateMetadata } from "../privacy.js";

describe("toPropagateMetadata", () => {
  it("stringifies and truncates to 200 chars", () => {
    const long = "x".repeat(250);
    expect(toPropagateMetadata({ source: "smoke", n: 3, long })).toEqual({
      source: "smoke",
      n: "3",
      long: "x".repeat(200),
    });
  });
});

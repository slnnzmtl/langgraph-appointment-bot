import { describe, expect, it } from "vitest";

import { renderFaqCatalogReply } from "../faq-catalog.js";

describe("renderFaqCatalogReply", () => {
  it("renders intro plus one canonical block from interaction choices", () => {
    expect(
      renderFaqCatalogReply(
        [
          { id: "c-0", label: "Родимки", serviceIds: ["svc-0"] },
          { id: "c-1", label: "Інші новоутворення", serviceIds: ["svc-1"] },
        ],
        [],
        "У цьому напрямі є кілька послуг",
      ),
    ).toBe(
      "У цьому напрямі є кілька послуг\n\n• Родимки\n• Інші новоутворення\n\nЯкий варіант вам підходить?",
    );
  });

  it("returns the empty-catalog fallback when choices are empty", () => {
    expect(renderFaqCatalogReply([])).toBe("Оберіть, будь ласка, послугу зі списку.");
  });
});

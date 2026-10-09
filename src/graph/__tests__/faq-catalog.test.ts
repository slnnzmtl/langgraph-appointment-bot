import { describe, expect, it } from "vitest";

import {
  buildFaqCatalogChoices,
  faqCatalogIntroFromModel,
  faqChoiceTextLabel,
  renderFaqCatalogReply,
  shortenFaqChoiceLabels,
} from "../faq-catalog.js";

const MAX_CHIP_LEN = 36;

describe("shortenFaqChoiceLabels", () => {
  it("keeps Пілінг after a direction chip that is not in the shared prefix", () => {
    const choices = shortenFaqChoiceLabels(
      [
        { id: "p1", label: "Пілінг поверхневий", serviceIds: ["p1"] },
        { id: "p2", label: "Пілінг серединний", serviceIds: ["p2"] },
      ],
      { selectedLabel: "Доглядові процедури" },
    );
    expect(choices.map((c) => faqChoiceTextLabel(c))).toEqual([
      "Пілінг поверхневий",
      "Пілінг серединний",
    ]);
  });

  it("strips Пілінг only after the patient chose Пілінг", () => {
    const choices = shortenFaqChoiceLabels(
      [
        { id: "p1", label: "Пілінг поверхневий", serviceIds: ["p1"] },
        { id: "p2", label: "Пілінг серединний", serviceIds: ["p2"] },
      ],
      { selectedLabel: "Пілінг" },
    );
    expect(choices.map((c) => c.label)).toEqual(["поверхневий", "серединний"]);
  });

  it("strips a chosen shared path even when each full name fits under 36 chars", () => {
    const choices = shortenFaqChoiceLabels(
      [
        {
          id: "1",
          label: "Ботулінотерапія Nabota 1 зона",
          serviceIds: ["1"],
        },
        {
          id: "2",
          label: "Ботулінотерапія Nabota 2 зони (лоб+міжбрів'я)",
          serviceIds: ["2"],
        },
        {
          id: "3",
          label: "Ботулінотерапія Nabota 3 зони (верхня третина)",
          serviceIds: ["3"],
        },
      ],
      { selectedLabel: "Ботулінотерапія" },
    );
    expect(choices.map((c) => faqChoiceTextLabel(c))).toEqual([
      "1 зона",
      "2 зони (лоб+міжбрів'я)",
      "3 зони (верхня третина)",
    ]);
    for (const choice of choices) {
      expect(choice.label.length).toBeLessThanOrEqual(MAX_CHIP_LEN);
      expect(faqChoiceTextLabel(choice).startsWith("Ботулінотерапія")).toBe(false);
    }
  });

  it("strips the selected path even when an outlier label breaks the global LCP", () => {
    const choices = shortenFaqChoiceLabels(
      [
        {
          id: "1",
          label: "Ботулінотерапія Botox, Disport 1 зона",
          serviceIds: ["1"],
        },
        {
          id: "2",
          label: "Ботулінотерапія Botox, Disport 2 зони (лоб+міжбрів'я)",
          serviceIds: ["2"],
        },
        {
          id: "3",
          label: "Ботулінотерапія Botox, Disport 3 зони (верхня третина)",
          serviceIds: ["3"],
        },
        {
          id: "4",
          label: "FULL FACE",
          serviceIds: ["4", "5"],
        },
      ],
      { selectedLabel: "Botox, Disport" },
    );
    expect(faqChoiceTextLabel(choices[0]!)).toBe("1 зона");
    expect(faqChoiceTextLabel(choices[1]!)).toBe("2 зони (лоб+міжбрів'я)");
    expect(faqChoiceTextLabel(choices[2]!)).toBe("3 зони (верхня третина)");
    expect(faqChoiceTextLabel(choices[3]!)).toBe("FULL FACE");
    expect(choices.map((c) => c.label).every((l) => !l.startsWith("Ботулінотерапія"))).toBe(
      true,
    );
  });

  it("does not strip a family prefix on root browse without a selected chip", () => {
    const choices = shortenFaqChoiceLabels([
      { id: "p1", label: "Пілінг поверхневий", serviceIds: ["p1"] },
      { id: "p2", label: "Пілінг серединний", serviceIds: ["p2"] },
    ]);
    expect(choices.map((c) => faqChoiceTextLabel(c))).toEqual([
      "Пілінг поверхневий",
      "Пілінг серединний",
    ]);
  });

  it("keeps full text in displayLabel when the chip is truncated after a chosen strip", () => {
    const longSuffix = "зона з дуже довгою уточнювальною назвою області";
    const choices = shortenFaqChoiceLabels(
      [
        {
          id: "1",
          label: `Ботулінотерапія Nabota ${longSuffix}`,
          serviceIds: ["1"],
        },
        {
          id: "2",
          label: "Ботулінотерапія Nabota 2 зони",
          serviceIds: ["2"],
        },
      ],
      { selectedLabel: "Ботулінотерапія" },
    );
    expect(faqChoiceTextLabel(choices[0]!)).toBe(longSuffix);
    expect(choices[0]!.label.length).toBeLessThanOrEqual(MAX_CHIP_LEN);
    expect(choices[0]!.displayLabel).toBe(longSuffix);
    expect(choices[0]!.label.endsWith("…")).toBe(true);
  });
});

describe("faqCatalogIntroFromModel", () => {
  it("drops a trailing question with emoji or markdown decoration", () => {
    expect(faqCatalogIntroFromModel("Який препарат вас цікавить? 🌿")).toBe("");
    expect(faqCatalogIntroFromModel("Який препарат вас цікавить?**")).toBe("");
    expect(faqCatalogIntroFromModel("*Який препарат вас цікавить?*")).toBe("");
  });

  it("keeps prose ahead of a decorated trailing question", () => {
    expect(
      faqCatalogIntroFromModel("Філери від 4500 грн. Який препарат вас цікавить? 🌿"),
    ).toBe("Філери від 4500 грн.");
  });

  it("still drops a bare trailing question paragraph", () => {
    expect(
      faqCatalogIntroFromModel("Коротке пояснення\n\nЯкий варіант вам підходить?"),
    ).toBe("Коротке пояснення");
  });
});

describe("renderFaqCatalogReply", () => {
  it("uses untruncated text labels for bullets and preserves model intro", () => {
    const choices = shortenFaqChoiceLabels(
      [
        {
          id: "1",
          label: "Ботулінотерапія Nabota 1 зона з довгою уточнювальною назвою",
          serviceIds: ["1"],
        },
        {
          id: "2",
          label: "Ботулінотерапія Nabota 2 зони (лоб+міжбрів'я)",
          serviceIds: ["2"],
        },
      ],
      { selectedLabel: "Ботулінотерапія" },
    );
    const reply = renderFaqCatalogReply(
      choices,
      [],
      "Для ботулінотерапії Nabota є такі варіанти",
    );
    expect(reply.startsWith("Для ботулінотерапії Nabota є такі варіанти\n\n")).toBe(true);
    for (const choice of choices) {
      expect(reply).toContain(`• ${faqChoiceTextLabel(choice)}`);
      if (choice.displayLabel != null) {
        expect(reply).not.toContain(`• ${choice.label}`);
      }
    }
    expect(reply.endsWith("Який варіант вам підходить?")).toBe(true);
  });

  it("falls back to a graph-owned intro when model prose is empty", () => {
    const reply = renderFaqCatalogReply([
      { id: "c-0", label: "Родимки", serviceIds: ["svc-0"] },
      { id: "c-1", label: "Інші новоутворення", serviceIds: ["svc-1"] },
    ]);
    expect(reply).toBe(
      "Доступні такі варіанти:\n\n• Родимки\n• Інші новоутворення\n\nЯкий варіант вам підходить?",
    );
  });

  it("includes a singleton CRM description once under the bullet", () => {
    const choices = [
      { id: "svc-a", label: "1 зона", serviceIds: ["svc-a"] },
      { id: "svc-b", label: "2 зони", serviceIds: ["svc-b"] },
    ];
    const reply = renderFaqCatalogReply(
      choices,
      [
        { id: "svc-a", name: "Ботулінотерапія Nabota 1 зона", description: "Одна зона обличчя" },
        { id: "svc-b", name: "Ботулінотерапія Nabota 2 зони" },
      ],
      "Ось варіанти зон",
    );
    expect(reply).toBe(
      "Ось варіанти зон\n\n• 1 зона\nОдна зона обличчя\n• 2 зони\n\nЯкий варіант вам підходить?",
    );
  });
});

describe("buildFaqCatalogChoices", () => {
  it("returns raw CRM names; shorten strips only after a selected path", () => {
    const rows = [
      { id: "1", name: "Ботулінотерапія Nabota FULL FACE+шия" },
      { id: "2", name: "Ботулінотерапія Botox, Dysport FULL FACE+шия" },
      { id: "3", name: "Ботулінотерапія Botox, Dysport ДАО,гінгівальна посмішка" },
      { id: "4", name: "Ботулінотерапія Botox, Dysport шия (платізма)" },
      { id: "5", name: "Ботулінотерапія Nabota шия (платізма)" },
      { id: "6", name: "Ботулінотерапія Nabota ДАО,гінгівальна посмішка" },
      { id: "7", name: "Ботулінотерапія Botox, Dysport 2 зони (лоб+міжбрів'я)" },
      { id: "8", name: "Ботулінотерапія Botox, Dysport 1 зона" },
    ];
    const unselected = shortenFaqChoiceLabels(buildFaqCatalogChoices(rows));
    expect(unselected.every((c) => faqChoiceTextLabel(c).startsWith("Ботулінотерапія"))).toBe(
      true,
    );
    const choices = shortenFaqChoiceLabels(buildFaqCatalogChoices(rows), {
      selectedLabel: "Ботулінотерапія",
    });
    expect(choices).toHaveLength(8);
    for (const choice of choices) {
      expect(faqChoiceTextLabel(choice).startsWith("Ботулінотерапія")).toBe(false);
      expect(choice.label.length).toBeLessThanOrEqual(MAX_CHIP_LEN);
    }
    expect(new Set(choices.map((c) => c.label)).size).toBe(8);
    expect(faqChoiceTextLabel(choices.find((c) => c.id === "1")!)).toContain("Nabota");
    expect(faqChoiceTextLabel(choices.find((c) => c.id === "8")!)).toContain("1 зона");
  });

  it("respects remainingIds when narrowing a family", () => {
    const services = [
      { id: "b1", name: "Ботулінотерапія Nabota FULL FACE+шия" },
      { id: "b2", name: "Ботулінотерапія Botox, Dysport 1 зона" },
      { id: "other", name: "Консультація" },
    ];
    const choices = shortenFaqChoiceLabels(
      buildFaqCatalogChoices(services, ["b1", "b2"]),
      { selectedLabel: "Ботулінотерапія" },
    );
    expect(choices).toHaveLength(2);
    expect(choices.every((c) => !faqChoiceTextLabel(c).startsWith("Ботулінотерапія"))).toBe(
      true,
    );
  });

  it("truncates a single long CRM name on the chip only", () => {
    const longName = "К".repeat(MAX_CHIP_LEN + 20);
    const choices = shortenFaqChoiceLabels(buildFaqCatalogChoices([{ id: "x", name: longName }]));
    expect(choices).toHaveLength(1);
    expect(choices[0]!.label.length).toBeLessThanOrEqual(MAX_CHIP_LEN);
    expect(choices[0]!.label.endsWith("…")).toBe(true);
    expect(choices[0]!.displayLabel).toBe(longName);
  });

  it("disambiguates chip labels that collide after truncation", () => {
    const prefix = "x".repeat(MAX_CHIP_LEN);
    const choices = shortenFaqChoiceLabels(buildFaqCatalogChoices([
      { id: "a", name: `${prefix}aaa` },
      { id: "b", name: `${prefix}bbb` },
    ]));
    expect(choices[0]!.label).not.toBe(choices[1]!.label);
    expect(choices[1]!.label).toContain("(2)");
  });
});

import { describe, expect, it } from "vitest";

import { SERVICE_CHANGE_ACK_UK } from "../../shared/clinic-constants.js";
import {
  renderBookingInteractionMessage,
  replyButtonsForInteraction,
} from "../booking/booking-interaction-render.js";
import { renderFaqCatalogReply, shortenFaqChoiceLabels } from "../catalog/faq-catalog.js";
import type { PendingInteraction } from "../booking/booking-session.js";

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

describe("renderBookingInteractionMessage service_candidate", () => {
  it("matches FAQ catalog body (ack + bullet block); chips stay truncated", () => {
    const choices = shortenFaqChoiceLabels([
      {
        id: "1",
        label: "Ботулінотерапія Botox, Disport 1 зона (лоб)",
        serviceIds: ["1"],
      },
      {
        id: "2",
        label: "Ботулінотерапія Botox, Disport 2 зони (лоб+міжбрів'я)",
        serviceIds: ["2"],
      },
      {
        id: "3",
        label: "Ботулінотерапія Botox, Disport 3 зони",
        serviceIds: ["3"],
      },
    ]);
    const interaction: PendingInteraction = {
      kind: "service_candidate",
      utterance: "Botox, Disport",
      owner: "booking",
      choices,
    };
    const reply = String(renderBookingInteractionMessage(interaction).content);
    // Same strings as FAQ finalize: shared catalogChoiceBulletBlock under the ack.
    expect(reply).toBe(renderFaqCatalogReply(choices, [], SERVICE_CHANGE_ACK_UK));
    for (const choice of choices) {
      expect(choice.displayLabel).toBeTruthy();
      expect(reply).not.toContain(`• ${choice.label}`);
    }
    expect(replyButtonsForInteraction(interaction)).toEqual(
      choices.map((choice) => choice.label),
    );
  });

  it("keeps ack-only copy when the catalog page has no listable choices", () => {
    const interaction: PendingInteraction = {
      kind: "service_candidate",
      utterance: "",
      owner: "booking",
      choices: [],
    };
    expect(String(renderBookingInteractionMessage(interaction).content)).toBe(
      SERVICE_CHANGE_ACK_UK,
    );
  });
});

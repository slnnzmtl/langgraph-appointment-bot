import { describe, expect, it } from "vitest";

import {
  interpretBookingTurnDeterministic,
  normalizeBookingTurnClassification,
  offeredChoiceIdFromOrdinal,
} from "../interpret.js";

describe("offered choice ordinals and labels", () => {
  const ids = ["slot-a", "slot-b", "slot-c"];
  const labels = ["14:00", "14:30", "15:00"];

  it("resolves UA and EN ordinals against the current offer only", () => {
    expect(offeredChoiceIdFromOrdinal("1", ids)).toBe("slot-a");
    expect(offeredChoiceIdFromOrdinal("другий", ids)).toBe("slot-b");
    expect(offeredChoiceIdFromOrdinal("third", ids)).toBe("slot-c");
    expect(offeredChoiceIdFromOrdinal("4", ids)).toBeNull();
  });

  it("resolves offered labels and fails closed for stale labels", () => {
    expect(
      interpretBookingTurnDeterministic({
        rawText: "14:30",
        offeredChoiceIds: ids,
        offeredChoiceLabels: labels,
      }),
    ).toMatchObject({ choice: { choiceId: "slot-b" } });

    expect(
      interpretBookingTurnDeterministic({
        rawText: "16:00",
        offeredChoiceIds: ids,
        offeredChoiceLabels: labels,
      }),
    ).toEqual({});
  });

  it("keeps informationalQuestion during service confirm", () => {
    const patch = normalizeBookingTurnClassification(
      {
        informationalQuestion: "how much is it?",
        faqTopic: "price",
        sideQuestionKind: "price",
      },
      { rawText: "how much is it?", awaitingServiceConfirm: true },
    );
    expect(patch.informationalQuestion).toBe("how much is it?");
    expect(patch.faqTopic).toBe("price");
  });
});

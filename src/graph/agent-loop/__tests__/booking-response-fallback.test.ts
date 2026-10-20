import { describe, expect, it } from "vitest";

import { LATER_DATE_LABEL, PATIENT_FALLBACK_MESSAGE } from "../../../shared/clinic-constants.js";
import { bookingResponseFallback } from "../booking-response-fallback.js";
import { replyChoicesFromCard } from "../booking-card-choices.js";

describe("bookingResponseFallback empty date window", () => {
  it("uses empty earlier copy, not PATIENT_FALLBACK_MESSAGE", () => {
    const card = {
      kind: "date_select" as const,
      snapshotId: "empty-earlier",
      choiceIds: ["later"],
      labels: { later: LATER_DATE_LABEL },
      emptyMode: "earlier" as const,
    };
    const text = bookingResponseFallback({
      intent: "present_dates",
      card,
    });
    expect(text).toBe("Раніших вільних дат не знайшли. Пошукати пізніші дати?");
    expect(text).not.toBe(PATIENT_FALLBACK_MESSAGE);
    expect(replyChoicesFromCard(card).map((c) => c.label)).toEqual([LATER_DATE_LABEL]);
  });
});

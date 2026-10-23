import { describe, expect, it } from "vitest";

import { reduceBookingDraft } from "../booking/booking-draft.js";
import { routeUnderstoodTurn } from "../receptionist-route.js";

describe("routeUnderstoodTurn", () => {
  it("routes visit_reschedule to booking", () => {
    const route = routeUnderstoodTurn(
      { controlIntent: { kind: "visit_reschedule" } },
      null,
    );
    expect(route.kind).toBe("booking");
  });

  it("routes idle faq without session to faq_capability", () => {
    const route = routeUnderstoodTurn(
      {
        idleFaq: { question: "where are you?", topic: "address" },
        faqTopic: "address",
      },
      null,
    );
    expect(route.kind).toBe("faq_capability");
  });

  it("routes idle informationalQuestion (hours) to faq_capability", () => {
    const route = routeUnderstoodTurn(
      {
        informationalQuestion: "hours",
        faqTopic: "hours",
      },
      null,
    );
    expect(route.kind).toBe("faq_capability");
  });

  it("routes idle consultation+price to faq_capability (not REPLACE)", () => {
    const route = routeUnderstoodTurn(
      {
        serviceIntent: { kind: "consultation" },
        informationalQuestion: "price",
        faqTopic: "price",
      },
      null,
    );
    expect(route.kind).toBe("faq_capability");
  });

  it("routes hours side question to booking while a session is open", () => {
    const draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "a1",
    });
    const route = routeUnderstoodTurn(
      {
        informationalQuestion: "hours",
        faqTopic: "hours",
      },
      draft,
    );
    expect(route.kind).toBe("booking");
  });

  it("keeps greeting during open booking as booking resume", () => {
    const draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "a1",
    });
    const route = routeUnderstoodTurn(
      { controlIntent: { kind: "greeting" } },
      draft,
    );
    expect(route.kind).toBe("booking");
  });

  it("routes catalog_browse without session to faq_capability", () => {
    const route = routeUnderstoodTurn(
      { serviceIntent: { kind: "catalog_browse" } },
      null,
    );
    expect(route.kind).toBe("faq_capability");
  });
});

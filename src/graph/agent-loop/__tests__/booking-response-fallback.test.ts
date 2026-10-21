import { describe, expect, it } from "vitest";

import {
  BOOKING_FIRST_NAME_INVALID_UK,
  BOOKING_LAST_NAME_INVALID_UK,
  BOOKING_PHONE_INVALID_UK,
  BOOKING_PHONE_QUESTION_UK,
  CLINIC_ADDRESS,
  CLINIC_MAPS_MARKDOWN,
  LATER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
} from "../../../shared/clinic-constants.js";
import { visitLabelFromCommand } from "../../../tools/visit-label.js";
import {
  bookingResponseFallback,
  bookingSuccessText,
  committedCreateOrRescheduleReply,
} from "../booking-response-fallback.js";
import { replyChoicesFromCard } from "../booking-card-choices.js";

describe("bookingResponseFallback contact format clarification", () => {
  it("prefers invalid_phone over generic ask_phone card copy", () => {
    const text = bookingResponseFallback({
      intent: "ask_phone",
      facts: { clarificationReason: "invalid_phone" },
      card: { kind: "contact_field", field: "phoneNumber" },
    });
    expect(text).toBe(BOOKING_PHONE_INVALID_UK);
    expect(text).not.toBe(BOOKING_PHONE_QUESTION_UK);
  });

  it("prefers invalid_firstName over generic ask_first_name card copy", () => {
    const text = bookingResponseFallback({
      intent: "ask_first_name",
      facts: { clarificationReason: "invalid_firstName" },
      card: { kind: "contact_field", field: "firstName" },
    });
    expect(text).toBe(BOOKING_FIRST_NAME_INVALID_UK);
  });

  it("prefers invalid_lastName over generic ask_last_name card copy", () => {
    const text = bookingResponseFallback({
      intent: "ask_last_name",
      facts: { clarificationReason: "invalid_lastName" },
      card: { kind: "contact_field", field: "lastName" },
    });
    expect(text).toBe(BOOKING_LAST_NAME_INVALID_UK);
  });
});

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

describe("bookingSuccessText visit confirmation", () => {
  it("uses Ukrainian visit label, sparkle, address, and maps — not ISO one-liner", () => {
    const dateStart = "2026-10-29T12:30:00";
    const visitLabel = visitLabelFromCommand("Консультація", dateStart);
    expect(visitLabel).toBeTruthy();

    const text = bookingSuccessText({
      action: "create",
      serviceName: "Консультація",
      dateStart,
      date: "2026-10-29",
      time: "12:30",
    });

    expect(text).toBe(committedCreateOrRescheduleReply("створено", visitLabel));
    expect(text).toBe(
      `Готово! Запис створено.\n\n${visitLabel} ✨\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`,
    );
    expect(text).toContain("о 12:30");
    expect(text).not.toContain("підтверджено");
    expect(text).not.toMatch(/Консультація 2026-10-29/);
  });

  it("uses перенесено for reschedule", () => {
    const text = bookingSuccessText({
      action: "reschedule",
      serviceName: "Консультація",
      dateStart: "2026-10-29T12:30:00",
    });
    expect(text.startsWith("Готово! Запис перенесено.")).toBe(true);
  });
});

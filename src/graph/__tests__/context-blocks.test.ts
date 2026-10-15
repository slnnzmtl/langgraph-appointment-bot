import { describe, expect, it, vi } from "vitest";

import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import {
  attachPrefetchVisits,
  formatBookingMeetingsContext,
  formatContactContext,
  formatMyVisitReply,
  formatPlannedVisitsFlag,
} from "../context-blocks.js";

const listedMeetings: BookingContext = {
  meetings: [
    {
      id: "m-1",
      name: "Консультація - Daniel",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    },
  ],
  dateFrom: "2026-08-11",
};

const listedContact: ContactLookupContext = {
  contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] }],
};

describe("formatBookingMeetingsContext", () => {
  it("returns an empty string when context is missing", async () => {
    expect(formatBookingMeetingsContext(null)).toBe("");
  });

  it("renders an empty meetings list so the model does not re-fetch", async () => {
    const block = formatBookingMeetingsContext({ meetings: [], dateFrom: "2026-08-11" });
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain('"meetings":[]');
    expect(block).toContain('"latestHeld":null');
    expect(block).not.toContain("When moving or cancelling");
  });

  it("wraps the list payload for uncached system metadata", async () => {
    const block = formatBookingMeetingsContext(listedMeetings);
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain("</list_planned_meetings>");
    expect(block).toContain('"id":"m-1"');
    expect(block).toContain('"dateStart":"2026-08-17 11:00:00"');
    expect(block).toContain('"dateFrom":"2026-08-11"');
    expect(block).toContain('"latestHeld":null');
  });

  it("includes latestHeld without visitLabel when prefetch set a past visit", async () => {
    const block = formatBookingMeetingsContext({
      ...listedMeetings,
      latestHeld: {
        id: "h-1",
        name: "Консультація - Ada Lovelace",
        dateStart: "2026-06-01 10:00:00",
        dateEnd: "2026-06-01 10:30:00",
      },
    });
    expect(block).toContain('"latestHeld":{"id":"h-1"');
    expect(block).toContain('"dateStart":"2026-06-01 10:00:00"');
    expect(block).not.toMatch(/"latestHeld":\{[^}]*"visitLabel"/);
  });

  it("adds a ready-to-quote Ukrainian visitLabel so the model does not format dates", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(formatBookingMeetingsContext(listedMeetings)).toContain(
        '"visitLabel":"Консультація — 17 серпня (понеділок) о 11:00"',
      );
      expect(formatBookingMeetingsContext(listedMeetings)).not.toContain('"whenLabel"');
      expect(formatBookingMeetingsContext(listedMeetings)).not.toContain('"serviceLabel"');
      vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
      expect(formatBookingMeetingsContext(listedMeetings)).toContain(
        '"visitLabel":"Консультація — завтра, 17 серпня (понеділок) о 11:00"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds visitLabel from CRM name (service before last ' - '), not chat", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      const block = formatBookingMeetingsContext(listedMeetings);
      expect(block).toContain(
        "When moving or cancelling, quote visitLabel from this block only — never a procedure from earlier chat.",
      );
      expect(block).toContain(
        '"visitLabel":"Консультація — 17 серпня (понеділок) о 11:00"',
      );
      expect(
        formatBookingMeetingsContext({
          dateFrom: "2026-08-11",
          meetings: [
            {
              id: "m-2",
              name: "Контурна пластика - 2 зони - Ada Lovelace",
              dateStart: "2026-08-17 11:00:00",
              dateEnd: "2026-08-17 11:30:00",
            },
          ],
        }),
      ).toContain('"visitLabel":"Контурна пластика - 2 зони — 17 серпня (понеділок) о 11:00"');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatPlannedVisitsFlag", () => {
  it("emits visits has/none under the meetings tag", async () => {
    expect(formatPlannedVisitsFlag(null)).toBe(
      '<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
    expect(formatPlannedVisitsFlag({ meetings: [], dateFrom: "2026-08-11" })).toBe(
      '<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
    expect(formatPlannedVisitsFlag(listedMeetings)).toBe(
      '<list_planned_meetings>\n{"visits":"has"}\n</list_planned_meetings>',
    );
  });

  it("ignores latestHeld — visits stays none when only history exists", async () => {
    expect(
      formatPlannedVisitsFlag({
        meetings: [],
        dateFrom: "2026-08-11",
        latestHeld: {
          id: "h-1",
          name: "Past",
          dateStart: "2026-06-01 10:00:00",
          dateEnd: "2026-06-01 10:30:00",
        },
      }),
    ).toBe('<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>');
  });
});

describe("attachPrefetchVisits", () => {
  it("replaces visit-ask with formatMyVisitReply", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(
        attachPrefetchVisits("stale 15:05 from chat", listedMeetings, "visit_ask"),
      ).toBe(formatMyVisitReply(listedMeetings));
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects prefetch lines on greeting even without a visit heading", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      const out = attachPrefetchVisits(
        "Привіт, Ada! Я ШІ-асистент.\n\nЧим можу допомогти?",
        listedMeetings,
        "greeting",
      );
      expect(out).toContain("🗓️ Консультація — 17 серпня (понеділок) о 11:00");
      expect(out).toContain("Чим можу допомогти?");
      expect(out.indexOf("Заплановані візити:")).toBeLessThan(out.indexOf("Чим можу допомогти?"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inject a list on other FINISH (thanks)", async () => {
    const out = attachPrefetchVisits(
      "Будь ласка! Чим ще можу допомогти?",
      listedMeetings,
      "other",
    );
    expect(out).toBe("Будь ласка! Чим ще можу допомогти?");
    expect(out).not.toContain("Заплановані візити:");
  });
});

describe("formatMyVisitReply", () => {
  it("lists prefetch labels and asks to move or cancel", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(formatMyVisitReply(listedMeetings)).toBe(
        "Заплановані візити:\n🗓️ Консультація — 17 серпня (понеділок) о 11:00\n\nБажаєте перенести або скасувати цей візит?",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatContactContext", () => {
  it("returns an empty string when context is missing", async () => {
    expect(formatContactContext(null)).toBe("");
  });

  it("renders an empty contacts list so the model does not re-fetch", async () => {
    const block = formatContactContext({ contacts: [] });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"contacts":[]');
  });

  it("renders error lookups as a completed prefetch block", async () => {
    const block = formatContactContext({ contacts: [], error: "CRM down" });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"lookupFailed":true');
    expect(block).not.toContain("CRM down");
  });

  it("wraps the contact payload for uncached system metadata", async () => {
    const block = formatContactContext(listedContact);
    expect(block).toContain("<contact_info>");
    expect(block).toContain("</contact_info>");
    expect(block).toContain(JSON.stringify({ contacts: listedContact.contacts }));
    expect(block).not.toContain("lookupFailed");
  });
});

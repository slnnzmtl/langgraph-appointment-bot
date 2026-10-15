import { describe, expect, it } from "vitest";

import { meetingServiceLabel, visitLabel, VISIT_LABEL_SEPARATOR } from "../meeting-label.js";

describe("meetingServiceLabel", () => {
  it("strips patient suffix after last CRM separator", () => {
    expect(meetingServiceLabel("Консультація - Daniel")).toBe("Консультація");
  });

  it("returns trimmed title when no separator", () => {
    expect(meetingServiceLabel("Consult")).toBe("Consult");
  });
});

describe("visitLabel", () => {
  it("joins service and when with em dash", () => {
    expect(visitLabel("Консультація - Ada", "17 серпня о 11:00")).toBe(
      `Консультація${VISIT_LABEL_SEPARATOR}17 серпня о 11:00`,
    );
  });
});

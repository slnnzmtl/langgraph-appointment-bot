import { describe, expect, it } from "vitest";

import {
  BOOKING_OFFER_MENU,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
} from "../../shared/clinic-constants.js";
import { BOOKING_SYSTEM_PROMPT } from "../booking.js";
import { SUPERVISOR_PROMPT } from "../supervisor.js";

const KEYBOARD_LABELS = [
  ...BOOKING_OFFER_MENU,
  INTENT_SKIP_LABEL,
  OTHER_DATE_LABEL,
  MAIN_MENU_LABEL,
  ...DEFAULT_MENU_NO_VISITS,
  ...DEFAULT_MENU_HAS_VISITS,
] as const;

describe("prompt structure", () => {
  it("composes booking prompt with required interpolated constants", () => {
    expect(BOOKING_SYSTEM_PROMPT).toContain(INTENT_SKIP_LABEL);
    for (const label of BOOKING_OFFER_MENU) {
      expect(BOOKING_SYSTEM_PROMPT).toContain(label);
    }
    expect(BOOKING_SYSTEM_PROMPT).toContain(OTHER_DATE_LABEL);
    expect(BOOKING_SYSTEM_PROMPT).toContain(CONSULTATION_SERVICE_ID);
  });

  it("composes supervisor prompt with required interpolated constants", () => {
    expect(SUPERVISOR_PROMPT).toContain(INTENT_SKIP_LABEL);
    for (const label of DEFAULT_MENU_NO_VISITS) {
      expect(SUPERVISOR_PROMPT).toContain(`«${label}»`);
    }
    for (const label of DEFAULT_MENU_HAS_VISITS) {
      expect(SUPERVISOR_PROMPT).toContain(`«${label}»`);
    }
  });

  it("includes every known keyboard label from clinic-constants in at least one composed prompt", () => {
    for (const label of KEYBOARD_LABELS) {
      const inBooking = BOOKING_SYSTEM_PROMPT.includes(label);
      const inSupervisor = SUPERVISOR_PROMPT.includes(label);
      expect(inBooking || inSupervisor, `missing keyboard label: ${label}`).toBe(true);
    }
  });
});

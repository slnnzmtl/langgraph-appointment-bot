import { describe, expect, it } from "vitest";

import {
  CLINIC_ADDRESS,
  CLINIC_DOCTOR_REF_UK,
  CLINIC_MAPS_MARKDOWN,
  CLINIC_WELCOME_VENUE_UK,
} from "../../shared/clinic-constants.js";
import { WELCOME_PREFIX } from "../welcome-message.js";

describe("WELCOME_PREFIX", () => {
  it("includes venue, doctor ref, address, and maps from clinic constants", () => {
    expect(WELCOME_PREFIX).toContain(CLINIC_WELCOME_VENUE_UK);
    expect(WELCOME_PREFIX).toContain(CLINIC_DOCTOR_REF_UK);
    expect(WELCOME_PREFIX).toContain(CLINIC_ADDRESS);
    expect(WELCOME_PREFIX).toContain(CLINIC_MAPS_MARKDOWN);
  });
});

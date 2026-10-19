/**
 * DDD-272 characterization index: documents high-risk paths already covered
 * elsewhere. Does not add skipped Phase 4 assertions — fixtures are data only.
 */
import { describe, expect, it } from "vitest";

import {
  addressAsideDuringTimeSelect,
  hoursAsideDuringDateSelect,
  multiFactCreatePatch,
  pausedHitlCheckpointMeta,
  sketchSessionAfterServiceAccepted,
} from "./fixtures/ddd-272-later-phase.js";

const HIGH_RISK_PATHS = [
  "consultation_vs_named_procedure",
  "availability_exact_nearest_empty_stale",
  "combined_date_time",
  "note_answered_skipped",
  "contacts_new_incomplete_linkable_occupied_ambiguous",
  "hitl_create_reschedule_cancel_outcomes",
  "replacement_booking",
  "faq_during_booking_sticky_catalog_detour",
  "visit_status_menu_abandon_handoff",
] as const;

describe("DDD-272 characterization coverage index", () => {
  it("lists every Linear high-risk path for the Phase 0 coverage map", () => {
    expect(HIGH_RISK_PATHS).toHaveLength(9);
  });

  it("exposes reusable later-phase fixtures without asserting Phase 4 behavior", () => {
    expect(multiFactCreatePatch.serviceIntent?.kind).toBe("named_procedure");
    expect(multiFactCreatePatch.scheduleIntent?.kind).toBe("date_and_time");
    expect(multiFactCreatePatch.contactFacts?.phoneNumber).toMatch(/^\+/);
    expect(hoursAsideDuringDateSelect.informationalQuestion).toBeTruthy();
    expect(addressAsideDuringTimeSelect.informationalQuestion).toBeTruthy();
    expect(pausedHitlCheckpointMeta).toMatchObject({
      interruptType: "confirm_booking",
      resumeNodeName: "booking__tools",
      expectedRecovery: "expired_confirmation",
    });
    expect(sketchSessionAfterServiceAccepted().schemaVersion).toBe(2);
  });
});

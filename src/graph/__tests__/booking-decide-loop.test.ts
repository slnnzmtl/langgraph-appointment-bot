import { describe, expect, it } from "vitest";

import { stampBookingEffect, assertStampedBookingToolCall } from "../agent-loop/stamp-booking-effect.js";
import { recoverExpiredConfirmBookingHitl } from "../booking-hitl-recovery.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";
import {
  classifyUpgradeForScan,
  emptyBookingCheckpointScanCounts,
} from "../booking-checkpoint-scanner.js";

describe("DDD-277 stamp + expired HITL recovery", () => {
  it("stamps booking effects for ToolNode", () => {
    const stamped = stampBookingEffect({
      id: "eff_1",
      expectedRevision: 1,
      status: "prepared",
      effect: { kind: "present_availability", queryKind: "nearest" },
    });
    expect(stamped.name).toBe("present_availability_slots");
    expect(stamped.args.__bookingEffectStamp).toBe("bookingEffectV1");
    expect(() => assertStampedBookingToolCall(stamped)).not.toThrow();
    expect(() => assertStampedBookingToolCall({ name: "create_meeting", args: {} })).toThrow(
      /Unstamped/,
    );
  });

  it("recovers legacy confirm without keeping frozen command", () => {
    let draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    })!;
    draft = reduceBookingDraft(draft, { type: "date_selected", date: "2026-09-10" })!;
    draft = reduceBookingDraft(draft, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
        label: "14:00",
      },
    })!;
    draft = {
      ...draft,
      pendingCommand: {
        action: "create",
        payload: { serviceId: "svc-1" },
      },
      phase: "confirming",
    };
    const recovered = recoverExpiredConfirmBookingHitl({ bookingDraft: draft });
    expect(recovered.bookingDraft?.pendingCommand).toBeNull();
    expect(recovered.bookingDraft?.slotProvenance).toBe("unverified_legacy");
    expect(recovered.replyText.length).toBeGreaterThan(0);
  });
});

describe("DDD-278A scanner stub outcomes", () => {
  it("counts migration buckets without PII", () => {
    const counts = emptyBookingCheckpointScanCounts();
    const outcome = classifyUpgradeForScan({
      unsupported: false,
      schemaVersionBefore: 1,
      targetSchemaVersion: 2,
      expiredHitl: false,
      slotRevalidation: true,
      recoveredPartial: false,
      failClosed: false,
    });
    counts[outcome] += 1;
    expect(counts.slot_revalidation).toBe(1);
    expect(counts.rejected).toBe(0);
  });
});

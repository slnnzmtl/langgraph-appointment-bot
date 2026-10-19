import { describe, expect, it } from "vitest";

import {
  BOOKING_SCHEMA_VERSION,
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import { upgradeBookingCheckpoint } from "../booking-session.js";
import { bookingDraftToSession, sessionToBookingDraft } from "../booking-session-convert.js";
import { nextBookingRequirement } from "../booking-domain/requirement.js";
import {
  classifyUpgradeForScan,
  emptyBookingCheckpointScanCounts,
} from "../booking-checkpoint-scanner.js";

const acceptedWithSlot = () => {
  const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: "svc-1", name: "Botox", source: "catalog" },
    accepted: true,
  });
  const dated = reduceBookingDraft(accepted!, {
    type: "date_selected",
    date: "2026-09-10",
  });
  return reduceBookingDraft(dated!, {
    type: "slot_selected",
    slot: {
      dateStart: "2026-09-10T14:00:00",
      dateEnd: "2026-09-10T14:30:00",
      label: "10 вер · 14:00",
    },
  })!;
};

describe("DDD-273 schema 2 upgrade", () => {
  it("is a no-op for already-current schema 2 with trusted slot evidence", () => {
    const draft = acceptedWithSlot();
    expect(draft.slotProvenance).toBe("availability_tool");
    expect(draft.slotEvidence?.snapshotId).toBeTruthy();
    const result = upgradeBookingCheckpoint({
      bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
      bookingDraft: draft,
    });
    expect(result.update).toEqual({});
    expect(result.unsupported).toBe(false);
  });

  it("demotes schema-2 slots that lack provenance or evidence", () => {
    const draft = acceptedWithSlot();
    const malformed = {
      ...draft,
      slotProvenance: null,
      slotEvidence: null,
      note: { status: "skipped" as const },
      contactId: "contact-1",
      pendingCommand: {
        action: "create" as const,
        payload: {
          serviceId: "svc-1",
          contactId: "contact-1",
          dateStart: draft.selectedSlot!.dateStart,
          dateEnd: draft.selectedSlot!.dateEnd,
        },
      },
      phase: "confirming" as const,
    };
    const result = upgradeBookingCheckpoint({
      bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
      bookingDraft: malformed,
    });
    expect(result.update.bookingDraft?.slotProvenance).toBe("unverified_legacy");
    expect(result.update.bookingDraft?.slotEvidence).toBeNull();
    expect(result.update.bookingDraft?.pendingCommand).toBeNull();
    expect(result.update.bookingDraft?.phase).toBe("time");
  });

  it("never promotes missing provenance to availability_tool on convert", () => {
    const draft = {
      ...acceptedWithSlot(),
      slotProvenance: null,
      slotEvidence: null,
    };
    const session = bookingDraftToSession(draft);
    expect(session.selectedSlot?.provenance).toBe("unverified_legacy");
    expect(nextBookingRequirement(session)).toBe("time");
  });

  it("upgrades schema 1: unverified slot, dirty prefetch, no dual schema write", () => {
    const draft = acceptedWithSlot();
    expect(draft.slotProvenance).toBe("availability_tool");
    const result = upgradeBookingCheckpoint({
      bookingSchemaVersion: 1,
      bookingDraft: {
        ...draft,
        slotProvenance: null,
      },
      pendingInteraction: {
        kind: "service_candidate",
        utterance: "botox",
        choices: [],
      },
    });
    expect(result.update.bookingSchemaVersion).toBe(2);
    expect(result.update.prefetchDirty).toBe(true);
    expect(result.update.availabilityContext).toBeNull();
    expect(result.update.bookingDraft?.slotProvenance).toBe("unverified_legacy");
    expect(result.update.bookingDraft?.pendingDecision).toEqual({
      kind: "service_candidate",
      utterance: "botox",
    });
    expect(result.update.bookingDraft?.phase).toBe("time");
  });

  it("expires legacy frozen HITL command on schema 1 upgrade", () => {
    const draft = acceptedWithSlot();
    const result = upgradeBookingCheckpoint({
      bookingSchemaVersion: 1,
      bookingDraft: {
        ...draft,
        slotProvenance: null,
        note: { status: "skipped" },
        contactId: "contact-1",
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Ada",
          lastName: "Lovelace",
        },
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            contactId: "contact-1",
            dateStart: draft.selectedSlot!.dateStart,
            dateEnd: draft.selectedSlot!.dateEnd,
          },
        },
        phase: "confirming",
      },
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [],
      },
    });
    expect(result.update.bookingDraft?.pendingCommand).toBeNull();
    expect(result.update.bookingDraft?.pendingDecision).toBeNull();
    expect(result.update.bookingDraft?.slotProvenance).toBe("unverified_legacy");
  });

  it("double-upgrade is idempotent after schema 2 stamp", () => {
    const first = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: acceptedWithSlot(),
    });
    const second = upgradeBookingCheckpoint({
      bookingSchemaVersion: first.update.bookingSchemaVersion,
      bookingDraft: first.update.bookingDraft,
      pendingInteraction: first.update.pendingInteraction as never,
    });
    expect(second.update).toEqual({});
  });

  it("round-trips draft ↔ session without inventing consultation", () => {
    const draft = acceptedWithSlot();
    const session = bookingDraftToSession(draft);
    expect(session.schemaVersion).toBe(2);
    expect(session.selectedSlot?.provenance).toBe("availability_tool");
    expect(nextBookingRequirement(session)).toBe("note");
    const back = sessionToBookingDraft(session);
    expect(back.serviceAcceptance?.service.id).toBe("svc-1");
    expect(back.selectedSlot?.dateStart).toBe(draft.selectedSlot?.dateStart);
    expect(back.pendingDecision ?? null).toBeNull();
  });

  it("scanner stub classifies expired HITL and empty counts", () => {
    expect(emptyBookingCheckpointScanCounts().upgrade).toBe(0);
    expect(
      classifyUpgradeForScan({
        unsupported: false,
        schemaVersionBefore: 1,
        targetSchemaVersion: 2,
        expiredHitl: true,
        slotRevalidation: true,
        recoveredPartial: false,
        failClosed: false,
      }),
    ).toBe("expired_hitl");
  });
});

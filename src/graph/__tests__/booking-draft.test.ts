import { describe, expect, it } from "vitest";

import {
  BOOKING_SCHEMA_VERSION,
  availabilityMatchesBooking,
  bookingAvailabilityScope,
  bookingVisitDurationMinutes,
  createEmptyBookingDraft,
  effectiveBookingContactDetails,
  isEmptyLegacyBookingDraft,
  nextMissingContactField,
  reduceBookingDraft,
  type BookingEvent,
} from "../booking-draft.js";
import { upgradeBookingCheckpoint } from "../booking-session.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import {
  clinicState,
  ownedContactContext,
} from "./agent-loop-fixtures.js";

describe("BookingDraft reducer", () => {
  const selectedSlot = {
    dateStart: "2026-10-17T11:30:00",
    dateEnd: "2026-10-17T12:00:00",
    label: "11:30",
  };



  it("fails closed on a slot missing label", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot: {
          dateStart: "2026-10-17T11:00:00",
          dateEnd: "2026-10-17T11:30:00",
        },
        note: { status: "skipped" },
        contactId: "c-1",
      } as never,
    });

    expect(upgraded.update.bookingDraft).toBeNull();
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("fails closed when confirming create payload serviceId mismatches the draft", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "c-1",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "other-svc",
            dateStart: selectedSlot.dateStart,
            dateEnd: selectedSlot.dateEnd,
          },
        },
        phase: "confirming",
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft).toMatchObject({
      serviceAcceptance: { service: { id: "svc-1" } },
      phase: "service",
      pendingCommand: null,
    });
  });

  it("fails closed when confirming create payload contactId mismatches the draft", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            contactId: "different-contact",
            dateStart: selectedSlot.dateStart,
            dateEnd: selectedSlot.dateEnd,
          },
        },
        phase: "confirming",
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft).toMatchObject({
      serviceAcceptance: { service: { id: "svc-1" } },
      phase: "service",
      pendingCommand: null,
      replacement: null,
    });
  });

  it("fails closed when confirming create payload is missing contactId", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            dateStart: selectedSlot.dateStart,
            dateEnd: selectedSlot.dateEnd,
          },
        },
        phase: "confirming",
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft?.pendingCommand).toBeNull();
  });

  it("clears replacement.originalCommand on fail-closed service-only recovery", () => {
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        contactId: "owned-contact",
        dateStart: selectedSlot.dateStart,
        dateEnd: selectedSlot.dateEnd,
      },
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "replace",
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            contactId: "different-contact",
            dateStart: selectedSlot.dateStart,
            dateEnd: selectedSlot.dateEnd,
          },
        },
        replacement: {
          meeting: { id: "m-old", name: "Старий запис" },
          status: "create_pending",
          originalCommand,
        },
        phase: "confirming",
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft).toMatchObject({
      phase: "service",
      pendingCommand: null,
      replacement: null,
    });
    expect(upgraded.update.bookingDraft?.replacement?.originalCommand).toBeUndefined();
  });

  it("strips originalCommand when keeping a replacement meeting without service", () => {
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        contactId: "c-1",
        dateStart: selectedSlot.dateStart,
        dateEnd: selectedSlot.dateEnd,
      },
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "replace",
        phase: "confirming",
        serviceAcceptance: null,
        replacement: {
          meeting: { id: "m-1", name: "Консультація" },
          status: "create_pending",
          originalCommand,
        },
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("canonical");
    expect(upgraded.update.bookingDraft).toMatchObject({
      replacement: {
        meeting: { id: "m-1" },
        status: "offered",
      },
      pendingCommand: null,
      serviceAcceptance: null,
    });
    expect(upgraded.update.bookingDraft?.replacement?.originalCommand).toBeUndefined();
    expect(upgraded.update.bookingDraft?.replacement?.status).not.toBe("create_pending");
  });

  it("fails closed when create_pending originalCommand contactId mismatches despite ready phase", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "replace",
        phase: "ready",
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: null,
        replacement: {
          meeting: { id: "m-old", name: "Старий запис" },
          status: "create_pending",
          originalCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              contactId: "different-contact",
              dateStart: selectedSlot.dateStart,
              dateEnd: selectedSlot.dateEnd,
            },
          },
        },
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft).toMatchObject({
      phase: "service",
      pendingCommand: null,
      replacement: null,
    });
    expect(upgraded.update.bookingDraft?.replacement?.originalCommand).toBeUndefined();
    expect(upgraded.update.bookingDraft?.replacement?.status).not.toBe("create_pending");
  });

  it("keeps a matching create_pending originalCommand when facts agree", () => {
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        contactId: "owned-contact",
        dateStart: selectedSlot.dateStart,
        dateEnd: selectedSlot.dateEnd,
      },
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "replace",
        phase: "ready",
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: null,
        replacement: {
          meeting: { id: "m-old", name: "Старий запис" },
          status: "create_pending",
          originalCommand,
        },
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("canonical");
    expect(upgraded.update.bookingDraft).toMatchObject({
      mode: "replace",
      replacement: {
        meeting: { id: "m-old" },
        status: "create_pending",
        originalCommand,
      },
      pendingCommand: null,
      contactId: "owned-contact",
    });
    assertCreatePendingMatchesCanonical(upgraded.update.bookingDraft);
  });

  it("fails closed when create_pending is missing a nested create command", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "replace",
        phase: "ready",
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot,
        note: { status: "skipped" },
        contactId: "owned-contact",
        pendingCommand: null,
        replacement: {
          meeting: { id: "m-old", name: "Старий запис" },
          status: "create_pending",
        },
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft?.replacement).toBeNull();
    expect(upgraded.update.bookingDraft?.replacement?.status).not.toBe("create_pending");
  });
});

/** Field-level invariant: resume-shaped create_pending must match canonical facts. */
const assertCreatePendingMatchesCanonical = (
  draft: ReturnType<typeof upgradeBookingCheckpoint>["update"]["bookingDraft"],
): void => {
  if (draft?.replacement?.status !== "create_pending") {
    return;
  }
  const command = draft.replacement.originalCommand;
  expect(command?.action).toBe("create");
  expect(command?.payload).toMatchObject({
    contactId: draft.contactId,
    serviceId: draft.serviceAcceptance?.service.id,
    dateStart: draft.selectedSlot?.dateStart,
    dateEnd: draft.selectedSlot?.dateEnd,
  });
};

describe("booking session lifecycle", () => {
  const selectedSlot = {
    dateStart: "2026-10-17T11:30:00",
    dateEnd: "2026-10-17T12:00:00",
    label: "11:30",
  };

  it("closes the session on draft_abandoned", () => {
    const active = reduceBookingDraft(null, {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    expect(reduceBookingDraft(active, { type: "draft_abandoned" })).toBeNull();
  });

  it("starts a clean create session from null", () => {
    const started = reduceBookingDraft(null, {
      type: "service_selected",
      service: { id: "svc-1", name: "Процедура", source: "catalog" },
      accepted: true,
    });
    expect(started).toMatchObject({
      mode: "create",
      phase: "date",
      serviceAcceptance: {
        status: "accepted",
        service: { id: "svc-1" },
      },
      selectedDate: null,
      selectedSlot: null,
      requestedTime: null,
      note: { status: "unasked" },
      pendingCommand: null,
      rescheduleTarget: null,
      replacement: null,
    });
  });

  it("starts a clean reschedule session from null", () => {
    const started = reduceBookingDraft(null, {
      type: "reschedule_started",
      meeting: { id: "m-1", name: "Консультація" },
    });
    expect(started).toMatchObject({
      mode: "reschedule",
      phase: "date",
      serviceAcceptance: null,
      selectedDate: null,
      selectedSlot: null,
      rescheduleTarget: { id: "m-1" },
      replacement: null,
      pendingCommand: null,
    });
  });

  it("opens a cancel command session from null", () => {
    const command = {
      action: "cancel" as const,
      payload: { meetingId: "m-1" },
    };
    expect(reduceBookingDraft(null, { type: "command_prepared", command })).toMatchObject({
      phase: "confirming",
      pendingCommand: command,
    });
  });

  it.each([
    [{ type: "service_accepted" }],
    [{ type: "date_selected", date: "2026-10-17" }],
    [{ type: "schedule_requested", date: "2026-10-17", preferredTime: "11:30" }],
    [{ type: "slot_selected", slot: selectedSlot }],
    [{ type: "requested_time_unavailable" }],
    [{ type: "note_status", status: "skipped" }],
    [{ type: "contact_resolved", contactId: "c-1" }],
    [{ type: "contact_unresolved" }],
    [{
      type: "command_prepared",
      command: {
        action: "create",
        payload: {
          serviceId: "svc-1",
          contactId: "c-1",
          dateStart: selectedSlot.dateStart,
          dateEnd: selectedSlot.dateEnd,
        },
      },
    }],
    [{ type: "command_cleared" }],
    [{ type: "existing_booking_detected", meeting: { id: "m-1" } }],
    [{
      type: "cancel_existing_requested",
      command: { action: "cancel", payload: { meetingId: "m-1" } },
    }],
    [{ type: "cancel_existing_completed" }],
    [{ type: "cancel_existing_declined" }],
    [{ type: "slot_invalidated" }],
    [{ type: "draft_resumed" }],
    [{ type: "draft_abandoned" }],
  ] as const satisfies ReadonlyArray<readonly [BookingEvent]>)(
    "returns null for non-start event %j on a closed session",
    (event) => {
      expect(reduceBookingDraft(null, event)).toBeNull();
    },
  );

  it("treats empty create drafts as legacy closed sessions", () => {
    const empty = createEmptyBookingDraft();
    expect(isEmptyLegacyBookingDraft(empty)).toBe(true);
    expect(isEmptyLegacyBookingDraft({
      ...empty,
      version: 9,
      contactId: "contact-1",
    })).toBe(true);
    expect(isEmptyLegacyBookingDraft(null)).toBe(false);
    expect(isEmptyLegacyBookingDraft({
      ...empty,
      serviceAcceptance: {
        status: "pending",
        service: { id: "svc-1", source: "catalog" },
      },
    })).toBe(false);
    expect(isEmptyLegacyBookingDraft({
      ...empty,
      selectedDate: "2026-10-17",
    })).toBe(false);
    expect(isEmptyLegacyBookingDraft({
      ...empty,
      note: { status: "awaiting" },
    })).toBe(false);
    expect(isEmptyLegacyBookingDraft({
      ...empty,
      replacement: { meeting: { id: "m-1" }, status: "offered" },
    })).toBe(false);
  });
});

describe("booking availability scope", () => {
  it("reads create duration from the accepted service", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-60", name: "Пілінг", durationMinutes: 60, source: "catalog" },
      accepted: true,
    });
    expect(bookingVisitDurationMinutes(draft)).toBe(60);
    expect(bookingAvailabilityScope(draft)).toEqual({
      serviceId: "svc-60",
      durationMinutes: 60,
    });
  });

  it("omits create duration when the accepted service has none", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    expect(bookingVisitDurationMinutes(draft)).toBeUndefined();
    expect(bookingAvailabilityScope(draft)).toEqual({ serviceId: "svc-1" });
  });

  it("reads reschedule duration from the CRM visit span", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "meeting-1",
        name: "Пілінг поверхневий",
        dateStart: "2026-10-26T11:00:00",
        dateEnd: "2026-10-26T12:00:00",
      },
    });
    expect(bookingVisitDurationMinutes(draft)).toBe(60);
    expect(bookingAvailabilityScope(draft)).toEqual({
      durationMinutes: 60,
      excludeMeetingIds: ["meeting-1"],
    });
  });

  it("omits reschedule duration when dateEnd is missing or the span is out of range", () => {
    const missingEnd = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1", dateStart: "2026-10-26T11:00:00" },
    });
    expect(bookingVisitDurationMinutes(missingEnd)).toBeUndefined();
    expect(bookingAvailabilityScope(missingEnd)).toEqual({
      excludeMeetingIds: ["meeting-1"],
    });

    const tooLong = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "meeting-1",
        dateStart: "2026-10-26T11:00:00",
        dateEnd: "2026-10-26T15:00:00",
      },
    });
    expect(bookingVisitDurationMinutes(tooLong)).toBeUndefined();
  });

  it("rejects a reschedule command whose payload span differs from the visit", () => {
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "meeting-1",
        dateStart: "2026-10-26T11:00:00",
        dateEnd: "2026-10-26T12:00:00",
      },
    });
    const dated = reduceBookingDraft(started, { type: "date_selected", date: "2026-10-23" });
    const shortSlot = {
      dateStart: "2026-10-23T11:00:00",
      dateEnd: "2026-10-23T11:30:00",
      label: "11:00",
    };
    const slotted = reduceBookingDraft(dated, { type: "slot_selected", slot: shortSlot });
    const rejected = reduceBookingDraft(slotted, {
      type: "command_prepared",
      command: {
        action: "reschedule",
        payload: {
          meetingId: "meeting-1",
          dateStart: shortSlot.dateStart,
          dateEnd: shortSlot.dateEnd,
        },
      },
    });
    expect(rejected.pendingCommand).toBeNull();
    expect(rejected.phase).toBe("ready");

    const fullSlot = {
      dateStart: "2026-10-23T11:00:00",
      dateEnd: "2026-10-23T12:00:00",
      label: "11:00",
    };
    const fullSlotted = reduceBookingDraft(dated, { type: "slot_selected", slot: fullSlot });
    const accepted = reduceBookingDraft(fullSlotted, {
      type: "command_prepared",
      command: {
        action: "reschedule",
        payload: {
          meetingId: "meeting-1",
          dateStart: fullSlot.dateStart,
          dateEnd: fullSlot.dateEnd,
        },
      },
    });
    expect(accepted.pendingCommand?.action).toBe("reschedule");
    expect(accepted.phase).toBe("confirming");
  });

  it("does not trust a 30-minute snapshot for a 60-minute reschedule", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: {
        id: "meeting-1",
        dateStart: "2026-10-26T11:00:00",
        dateEnd: "2026-10-26T12:00:00",
      },
    });
    expect(availabilityMatchesBooking(
      {
        stepMinutes: 30,
        excludeMeetingIds: ["meeting-1"],
        days: [{
          slots: [{
            dateStart: "2026-10-23T11:00:00",
            dateEnd: "2026-10-23T11:30:00",
          }],
        }],
      },
      draft,
    )).toBe(false);
    expect(availabilityMatchesBooking(
      {
        stepMinutes: 60,
        excludeMeetingIds: ["meeting-1"],
      },
      draft,
    )).toBe(true);
    // Legacy checkpoints stored start cadence in stepMinutes; slot spans win.
    expect(availabilityMatchesBooking(
      {
        stepMinutes: 30,
        excludeMeetingIds: ["meeting-1"],
        days: [{
          slots: [{
            dateStart: "2026-10-23T11:00:00",
            dateEnd: "2026-10-23T12:00:00",
          }],
        }],
      },
      draft,
    )).toBe(true);
  });
});

describe("BookingDraft contactDetails", () => {
  const detailsReady = () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      accepted: true,
    });
    return reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(accepted, { type: "date_selected", date: "2026-10-17" }),
        {
          type: "slot_selected",
          slot: {
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
            label: "11:30",
          },
        },
      ),
      { type: "note_status", status: "skipped" },
    );
  };

  it("stores normalized E.164 phone on contact_field_submitted", () => {
    const next = reduceBookingDraft(detailsReady(), {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "0501112233",
    });
    expect(next.contactDetails).toEqual({ phoneNumber: "+380501112233" });
  });

  it("persists names across link-style contact_resolved and clears only with clearDetails", () => {
    let draft = reduceBookingDraft(detailsReady(), {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "+380501112233",
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "firstName",
      value: " Олена ",
    });
    draft = reduceBookingDraft(draft, {
      type: "contact_field_submitted",
      field: "lastName",
      value: "Коваль",
    });
    expect(draft.contactDetails).toEqual({
      phoneNumber: "+380501112233",
      firstName: "Олена",
      lastName: "Коваль",
    });
    const linked = reduceBookingDraft(draft, {
      type: "contact_resolved",
      contactId: "c-1",
    });
    expect(linked.contactId).toBe("c-1");
    expect(linked.phase).toBe("ready");
    expect(linked.contactDetails).toEqual({
      phoneNumber: "+380501112233",
      firstName: "Олена",
      lastName: "Коваль",
    });
    const cleared = reduceBookingDraft(linked, {
      type: "contact_resolved",
      contactId: "c-1",
      clearDetails: true,
    });
    expect(cleared.contactDetails).toBeNull();
    expect(cleared.phase).toBe("ready");
  });

  it("stays in details after contact_resolved when draft identity is still incomplete", () => {
    const withPhone = reduceBookingDraft(detailsReady(), {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "+380501112233",
    });
    const linked = reduceBookingDraft(withPhone, {
      type: "contact_resolved",
      contactId: "c-incomplete",
    });
    expect(linked.contactId).toBe("c-incomplete");
    expect(linked.phase).toBe("details");
    expect(nextMissingContactField(linked.contactDetails ?? {})).toBe("firstName");
  });

  it("keeps contactDetails across contact_unresolved and abandons with the draft", () => {
    const withPhone = reduceBookingDraft(detailsReady(), {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "+380501112233",
    });
    const unresolved = reduceBookingDraft(withPhone, { type: "contact_unresolved" });
    expect(unresolved.contactDetails).toEqual({ phoneNumber: "+380501112233" });
    expect(reduceBookingDraft(withPhone, { type: "draft_abandoned" })).toBeNull();
  });

  it("folds individual missing fields from legacy collected", () => {
    const effective = effectiveBookingContactDetails({
      contactDetails: { phoneNumber: "+380501112233", firstName: "Олена" },
      collected: { lastName: "Коваль" },
    });
    expect(effective).toEqual({
      phoneNumber: "+380501112233",
      firstName: "Олена",
      lastName: "Коваль",
    });
    expect(nextMissingContactField(effective)).toBeNull();
  });

  it("overlays CRM with draft so owned incomplete contact asks only the missing field", () => {
    const effective = effectiveBookingContactDetails({
      crmContact: {
        id: "c-1",
        phoneNumber: "+380501112233",
        firstName: "Олена",
        lastName: "",
      },
      contactDetails: null,
    });
    expect(nextMissingContactField(effective)).toBe("lastName");
  });

  it("reads drafts without contactDetails as null and keeps schema v2", () => {
    const empty = createEmptyBookingDraft();
    expect(empty.contactDetails).toBeNull();
    expect(BOOKING_SCHEMA_VERSION).toBe(2);
    const withService = reduceBookingDraft(empty, {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      accepted: true,
    });
    expect(withService.contactDetails ?? null).toBeNull();
  });
});

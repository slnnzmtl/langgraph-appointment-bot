import { describe, expect, it } from "vitest";

import {
  BOOKING_SCHEMA_VERSION,
  createEmptyBookingDraft,
  isEmptyLegacyBookingDraft,
  reduceBookingDraft,
  type BookingEvent,
} from "../booking-draft.js";
import { upgradeBookingCheckpoint } from "../booking-session.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";

describe("BookingDraft reducer", () => {
  const selectedSlot = {
    dateStart: "2026-10-17T11:30:00",
    dateEnd: "2026-10-17T12:00:00",
    label: "11:30",
  };

  it("does not advance date, slot, or note before service acceptance", () => {
    const empty = createEmptyBookingDraft();
    const afterDate = reduceBookingDraft(empty, { type: "date_selected", date: "2026-10-17" });
    const afterSlot = reduceBookingDraft(afterDate, { type: "slot_selected", slot: selectedSlot });
    const afterNote = reduceBookingDraft(afterSlot, { type: "note_status", status: "skipped" });

    expect(afterDate).toEqual(empty);
    expect(afterSlot).toEqual(empty);
    expect(afterNote).toEqual(empty);
  });

  it("does not select a slot until an accepted service and matching date exist", () => {
    const pending = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: false,
    });
    const accepted = reduceBookingDraft(pending, { type: "service_accepted" });
    const wrongDate = reduceBookingDraft(accepted, { type: "slot_selected", slot: selectedSlot });
    const withDate = reduceBookingDraft(accepted, { type: "date_selected", date: "2026-10-17" });
    const withSlot = reduceBookingDraft(withDate, { type: "slot_selected", slot: selectedSlot });

    expect(wrongDate).toEqual(accepted);
    expect(withSlot.selectedSlot).toEqual(selectedSlot);
    expect(withSlot.phase).toBe("note");
  });

  it("does not complete the note step before a slot is selected", () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    const unchanged = reduceBookingDraft(accepted, {
      type: "note_status",
      status: "answered",
      value: "detail",
    });

    expect(unchanged).toEqual(accepted);
  });

  it("does not prepare a command until all booking prerequisites are present", () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    const command = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        dateStart: selectedSlot.dateStart,
        dateEnd: selectedSlot.dateEnd,
        contactId: "c-1",
      },
    };
    const incomplete = reduceBookingDraft(accepted, { type: "command_prepared", command });
    const ready = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(
          reduceBookingDraft(accepted, { type: "date_selected", date: "2026-10-17" }),
          { type: "slot_selected", slot: selectedSlot },
        ),
        { type: "note_status", status: "skipped" },
      ),
      { type: "contact_resolved", contactId: "c-1" },
    );
    const prepared = reduceBookingDraft(ready, { type: "command_prepared", command });

    expect(incomplete).toEqual(accepted);
    expect(prepared.phase).toBe("confirming");
    expect(prepared.pendingCommand).toEqual(command);
  });

  it("folds consultation acceptance before a following date event", () => {
    const pending = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "consultation", name: "Консультація", source: "catalog" },
      accepted: false,
    });
    const accepted = reduceBookingDraft(pending, { type: "service_accepted" });
    const withDate = reduceBookingDraft(accepted, { type: "date_selected", date: "2026-10-16" });

    expect(withDate.serviceAcceptance?.status).toBe("accepted");
    expect(withDate.selectedDate).toBe("2026-10-16");
    expect(withDate.phase).toBe("time");
  });

  it("persists a requested date and time without treating the time as CRM evidence", () => {
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1", name: "Візит" },
    });
    const requested = reduceBookingDraft(started, {
      type: "schedule_requested",
      date: "2026-10-16",
      preferredTime: "14:00",
    });

    expect(requested.phase).toBe("time");
    expect(requested.selectedDate).toBe("2026-10-16");
    expect(requested.selectedSlot).toBeNull();
    expect(requested.requestedTime).toEqual({ value: "14:00", status: "pending" });
  });

  it("clears requested time when a CRM slot is selected and never enters the note phase for reschedule", () => {
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1" },
    });
    const requested = reduceBookingDraft(started, {
      type: "schedule_requested",
      date: "2026-10-16",
      preferredTime: "14:00",
    });
    const selected = reduceBookingDraft(requested, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-16T14:00:00",
        dateEnd: "2026-10-16T14:30:00",
        label: "14:00",
      },
    });

    expect(selected.phase).toBe("ready");
    expect(selected.requestedTime).toBeNull();
    expect(selected.note.status).toBe("unasked");
  });

  it("marks a requested time unavailable without losing the selected date", () => {
    const requested = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: { id: "meeting-1" },
      }),
      { type: "schedule_requested", date: "2026-10-16", preferredTime: "14:00" },
    );
    const unavailable = reduceBookingDraft(requested, { type: "requested_time_unavailable" });

    expect(unavailable.selectedDate).toBe("2026-10-16");
    expect(unavailable.selectedSlot).toBeNull();
    expect(unavailable.requestedTime).toEqual({ value: "14:00", status: "unavailable" });
    expect(unavailable.phase).toBe("time");
  });

  it("supports direct reschedule date/time without create-booking prerequisites", () => {
    const target = { id: "meeting-1", name: "Консультація" };
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: target,
    });
    const dated = reduceBookingDraft(started, { type: "date_selected", date: "2026-10-17" });
    const slotted = reduceBookingDraft(dated, { type: "slot_selected", slot: selectedSlot });
    const prepared = reduceBookingDraft(slotted, {
      type: "command_prepared",
      command: {
        action: "reschedule",
        payload: {
          meetingId: "meeting-1",
          dateStart: selectedSlot.dateStart,
          dateEnd: selectedSlot.dateEnd,
        },
      },
    });

    expect(dated.phase).toBe("time");
    expect(slotted.phase).toBe("ready");
    expect(slotted.note.status).toBe("unasked");
    expect(prepared.phase).toBe("confirming");
    expect(prepared.pendingCommand?.action).toBe("reschedule");
  });

  it("keeps the reschedule target when its selected slot is invalidated", () => {
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1" },
    });
    const dated = reduceBookingDraft(started, { type: "date_selected", date: "2026-10-17" });
    const slotted = reduceBookingDraft(dated, { type: "slot_selected", slot: selectedSlot });
    const invalidated = reduceBookingDraft(slotted, { type: "slot_invalidated" });

    expect(invalidated.mode).toBe("reschedule");
    expect(invalidated.rescheduleTarget?.id).toBe("meeting-1");
    expect(invalidated.selectedSlot).toBeNull();
    expect(invalidated.phase).toBe("date");
  });

  it("preserves downstream facts when the same service is reaffirmed", () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(
          reduceBookingDraft(
            reduceBookingDraft(createEmptyBookingDraft(), {
              type: "service_selected",
              service: { id: "svc-1", source: "catalog" },
              accepted: true,
            }),
            { type: "date_selected", date: "2026-10-17" },
          ),
          { type: "slot_selected", slot: selectedSlot },
        ),
        { type: "note_status", status: "answered", value: "concern" },
      ),
      { type: "contact_resolved", contactId: "c-1" },
    );
    const reaffirmed = reduceBookingDraft(draft, {
      type: "service_selected",
      service: { id: "svc-1", source: "direct" },
      accepted: true,
    });

    expect(reaffirmed.selectedDate).toBe(draft.selectedDate);
    expect(reaffirmed.selectedSlot).toEqual(draft.selectedSlot);
    expect(reaffirmed.note).toEqual(draft.note);
    expect(reaffirmed.contactId).toBe("c-1");
  });

  it("accepts a catalog service without clearing later facts", () => {
    const selected = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-consult", name: "Консультація первинна", source: "catalog" },
      accepted: true,
    });
    const withDate = reduceBookingDraft(selected, {
      type: "date_selected",
      date: "2026-10-17",
    });
    const withSlot = reduceBookingDraft(withDate, {
      type: "slot_selected",
      slot: {
        slotId: "slot-1",
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
        label: "11:30",
      },
    });

    expect(withSlot.serviceAcceptance?.status).toBe("accepted");
    expect(withSlot.serviceAcceptance?.service.id).toBe("svc-consult");
    expect(withSlot.selectedSlot?.dateStart).toBe("2026-10-17T11:30:00");
  });

  it("clears incompatible selections on service change", () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", source: "catalog" },
          accepted: true,
        }),
        { type: "date_selected", date: "2026-10-17" },
      ),
      { type: "slot_selected", slot: {
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
        label: "11:30",
      } },
    );
    const changed = reduceBookingDraft(draft, {
      type: "service_selected",
      service: { id: "svc-2", source: "catalog" },
      accepted: false,
    });

    expect(changed.serviceAcceptance?.service.id).toBe("svc-2");
    expect(changed.serviceAcceptance?.status).toBe("pending");
    expect(changed.selectedDate).toBeNull();
    expect(changed.selectedSlot).toBeNull();
    expect(changed.note.status).toBe("unasked");
  });

  it("does not clear downstream facts when the same service is reaffirmed", () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", name: "Консультація", source: "catalog" },
          accepted: true,
        }),
        { type: "date_selected", date: "2026-10-17" },
      ),
      {
        type: "slot_selected",
        slot: {
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
          label: "11:30",
        },
      },
    );
    const reaffirmed = reduceBookingDraft(draft, {
      type: "service_selected",
      service: { id: "svc-1", name: "Консультація", source: "direct" },
      accepted: true,
    });

    expect(reaffirmed.serviceAcceptance?.status).toBe("accepted");
    expect(reaffirmed.selectedDate).toBe("2026-10-17");
    expect(reaffirmed.selectedSlot?.dateStart).toBe("2026-10-17T11:30:00");
    expect(reaffirmed.note.status).toBe("awaiting");
  });

  it("invalidates only the slot after an availability refresh", () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", source: "catalog" },
          accepted: true,
        }),
        { type: "date_selected", date: "2026-10-17" },
      ),
      {
        type: "slot_selected",
        slot: {
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
          label: "11:30",
        },
      },
    );
    const draftWithNote = reduceBookingDraft(draft, { type: "note_status", status: "skipped" });
    const recovered = reduceBookingDraft(draftWithNote, { type: "slot_invalidated", keepDate: false });

    expect(recovered.serviceAcceptance?.service.id).toBe("svc-1");
    expect(recovered.selectedSlot).toBeNull();
    expect(recovered.note.status).toBe("skipped");
  });

  it("preserves the replacement command and booking facts across cancellation", () => {
    const readyWithSlot = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", source: "catalog" },
          accepted: true,
        }),
        { type: "date_selected", date: "2026-10-17" },
      ),
      {
        type: "slot_selected",
        slot: {
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
          label: "11:30",
        },
      },
    );
    const ready = reduceBookingDraft(
      reduceBookingDraft(readyWithSlot, { type: "note_status", status: "skipped" }),
      { type: "contact_resolved", contactId: "c-1" },
    );
    const command = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        contactId: "c-1",
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
      },
    };
    const offered = reduceBookingDraft(
      reduceBookingDraft(ready, { type: "command_prepared", command }),
      {
        type: "existing_booking_detected",
        meeting: { id: "existing-1", name: "Existing visit" },
      },
    );

    expect(offered.replacement?.status).toBe("offered");
    expect(offered.replacement?.originalCommand).toEqual(command);
    expect(offered.selectedSlot?.dateStart).toBe("2026-10-17T11:30:00");
    expect(offered.note.status).toBe("skipped");

    const cancelling = reduceBookingDraft(offered, {
      type: "cancel_existing_requested",
      command: {
        action: "cancel",
        payload: { meetingId: "existing-1" },
      },
    });
    const readyToReplace = reduceBookingDraft(cancelling, {
      type: "cancel_existing_completed",
    });

    expect(readyToReplace.replacement?.status).toBe("create_pending");
    expect(readyToReplace.replacement?.originalCommand).toEqual(command);
    expect(readyToReplace.pendingCommand).toBeNull();
    expect(readyToReplace.selectedSlot?.dateStart).toBe("2026-10-17T11:30:00");
    expect(readyToReplace.note.status).toBe("skipped");

    const declined = reduceBookingDraft(offered, { type: "cancel_existing_declined" });
    expect(declined).toBeNull();
  });

  it("does not invent Consultation from projections alone", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      selectedAvailabilityDate: "2026-10-17",
      selectedSlot,
      bookingNoteStatus: "awaiting",
    });

    expect(upgraded.update).toMatchObject({
      bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
      bookingDraft: null,
      bookingNoteStatus: "unasked",
      selectedSlot: null,
      selectedAvailabilityDate: null,
    });
    expect(upgraded.telemetry).toMatchObject({
      source: "legacy_projection",
      schemaVersion: 0,
      outcome: "fail_closed",
    });
  });

  it("keeps a valid accepted draft and clears legacy projections", () => {
    const draft = {
      ...createEmptyBookingDraft(),
      version: 7,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "direct" as const },
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "answered" as const, value: "потрібен час" },
      contactId: "contact-1",
      phase: "ready" as const,
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft,
      bookingNoteStatus: "answered",
      selectedSlot,
      selectedAvailabilityDate: "2026-10-17",
    });
    const repeated = upgradeBookingCheckpoint({
      ...upgraded.update,
      bookingDraft: upgraded.update.bookingDraft,
    });

    expect(upgraded.update.bookingDraft).toMatchObject({
      version: 7,
      phase: "ready",
      serviceAcceptance: {
        status: "accepted",
        service: { id: CONSULTATION_SERVICE_ID },
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "answered", value: "потрібен час" },
      contactId: "contact-1",
    });
    expect(upgraded.update.bookingSchemaVersion).toBe(BOOKING_SCHEMA_VERSION);
    expect(repeated.update).toEqual({});
    expect(repeated.telemetry).toBeNull();
  });

  it("opens visit_note once when upgrading a slot with an awaiting note", () => {
    const draft = {
      ...createEmptyBookingDraft(),
      version: 3,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: "svc-1", source: "catalog" as const },
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "awaiting" as const },
      phase: "note" as const,
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft,
    });

    expect(upgraded.update.bookingDraft?.note.status).toBe("awaiting");
    expect(upgraded.update.pendingInteraction).toEqual({
      kind: "visit_note",
      choices: [{ id: "skip", label: "Продовжити без коментаря" }],
    });
  });

  it("nulls a blank service id and clears projections", () => {
    const malformed = {
      ...createEmptyBookingDraft(),
      version: 7,
      serviceAcceptance: {
        status: "accepted" as const,
        service: undefined,
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "answered" as const, value: "потрібен час" },
      contactId: "contact-1",
    } as never;
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: malformed,
    });

    expect(upgraded.update.bookingDraft).toBeNull();
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("keeps a valid service only when slot date and selectedDate disagree", () => {
    const draft = {
      ...createEmptyBookingDraft(),
      version: 3,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: "svc-1", source: "catalog" as const },
      },
      selectedDate: "2026-10-16",
      selectedSlot,
      note: { status: "answered" as const, value: "біль" },
      phase: "note" as const,
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft,
    });

    expect(upgraded.update.bookingDraft).toMatchObject({
      serviceAcceptance: { status: "accepted", service: { id: "svc-1" } },
      phase: "service",
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
      pendingCommand: null,
    });
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("keeps a reschedule draft that has a target and no service id", () => {
    const draft = {
      ...createEmptyBookingDraft(),
      mode: "reschedule" as const,
      phase: "date" as const,
      rescheduleTarget: { id: "meeting-1", name: "Консультація" },
    };
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft,
    });

    expect(upgraded.update.bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "meeting-1" },
      serviceAcceptance: null,
    });
    expect(upgraded.update.bookingDraft).not.toBeNull();
  });

  it("canonicalizes an empty legacy draft to null", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: createEmptyBookingDraft(),
    });
    expect(upgraded.update.bookingDraft).toBeNull();
    expect(upgraded.telemetry).toMatchObject({
      source: "empty_draft",
      outcome: "canonical",
    });
  });

  it("stamps schema version 1 on an already-empty new chat without telemetry", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: null,
    });
    expect(upgraded.update).toEqual({
      bookingSchemaVersion: BOOKING_SCHEMA_VERSION,
      bookingNoteStatus: "unasked",
      selectedSlot: null,
      selectedAvailabilityDate: null,
      bookingDraft: null,
    });
    expect(upgraded.telemetry).toBeNull();
  });

  it("refuses unsupported schema versions without rewriting", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 2,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
      },
    });
    expect(upgraded.update).toEqual({});
    expect(upgraded.unsupported).toBe(true);
    expect(upgraded.telemetry).toEqual({
      source: "legacy_draft",
      schemaVersion: 2,
      outcome: "unsupported",
    });
  });

  it("rejects negative and non-integer schema versions without rewriting", () => {
    for (const schemaVersion of [-1, 1.5]) {
      const upgraded = upgradeBookingCheckpoint({
        bookingSchemaVersion: schemaVersion,
        bookingDraft: {
          ...createEmptyBookingDraft(),
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
        },
      });
      expect(upgraded.update).toEqual({});
      expect(upgraded.unsupported).toBe(true);
      expect(upgraded.telemetry).toMatchObject({
        outcome: "unsupported",
        schemaVersion,
      });
    }
  });

  it("fails closed on whitespace service id, inverted slot, and pending command", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        version: 4,
        serviceAcceptance: {
          status: "accepted",
          service: { id: "   ", source: "catalog" },
        },
        selectedDate: "2026-10-17",
        selectedSlot: {
          dateStart: "2026-10-17T12:00:00",
          dateEnd: "2026-10-17T11:00:00",
          label: "12:00",
        },
        note: { status: "answered", value: "біль" },
        pendingCommand: { action: "create", payload: { serviceId: "   " } },
        phase: "confirming",
      },
    });

    expect(upgraded.update.bookingDraft).toBeNull();
    expect(upgraded.update.bookingSchemaVersion).toBe(BOOKING_SCHEMA_VERSION);
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("keeps a trimmed service only when the slot interval is inverted", () => {
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
          dateStart: "2026-10-17T12:00:00",
          dateEnd: "2026-10-17T11:00:00",
          label: "12:00",
        },
        note: { status: "answered", value: "біль" },
        pendingCommand: { action: "create", payload: {} },
        phase: "confirming",
      },
    });

    expect(upgraded.update.bookingDraft).toMatchObject({
      serviceAcceptance: { status: "accepted", service: { id: "svc-1" } },
      phase: "service",
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
      pendingCommand: null,
    });
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("fails closed without throwing when note is missing", () => {
    const draft = {
      ...createEmptyBookingDraft(),
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: "svc-1", source: "catalog" as const },
      },
    };
    delete (draft as { note?: unknown }).note;
    expect(() => upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft as never,
    })).not.toThrow();
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: draft as never,
    });
    expect(upgraded.update.bookingDraft).toBeNull();
    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
  });

  it("emits canonical telemetry when stamping a non-empty version-0 draft", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        phase: "date",
      },
    });
    expect(upgraded.update.bookingSchemaVersion).toBe(BOOKING_SCHEMA_VERSION);
    expect(upgraded.telemetry).toEqual({
      source: "legacy_draft",
      schemaVersion: 0,
      outcome: "canonical",
    });
  });

  it("fails closed when confirming create has a slot but no selectedDate", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: null,
        selectedSlot,
        note: { status: "skipped" },
        contactId: "c-1",
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
    expect(upgraded.update.bookingDraft).toMatchObject({
      serviceAcceptance: { service: { id: "svc-1" } },
      phase: "service",
      selectedDate: null,
      selectedSlot: null,
      pendingCommand: null,
      note: { status: "unasked" },
    });
  });

  it("fails closed on calendar-impossible selectedDate", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        serviceAcceptance: {
          status: "accepted",
          service: { id: "svc-1", source: "catalog" },
        },
        selectedDate: "2026-99-99",
        selectedSlot: {
          dateStart: "2026-99-99T11:00:00",
          dateEnd: "2026-99-99T11:30:00",
          label: "11:00",
        },
        note: { status: "skipped" },
        contactId: "c-1",
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            dateStart: "2026-99-99T11:00:00",
            dateEnd: "2026-99-99T11:30:00",
          },
        },
        phase: "confirming",
      },
    });

    expect(upgraded.telemetry?.outcome).toBe("fail_closed");
    expect(upgraded.update.bookingDraft?.pendingCommand).toBeNull();
  });

  it("fails closed on a blank reschedule target id", () => {
    const upgraded = upgradeBookingCheckpoint({
      bookingSchemaVersion: 0,
      bookingDraft: {
        ...createEmptyBookingDraft(),
        mode: "reschedule",
        phase: "date",
        rescheduleTarget: { id: "  ", name: "Консультація" },
      },
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

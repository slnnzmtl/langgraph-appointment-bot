import { describe, expect, it } from "vitest";

import {
  createEmptyBookingDraft,
  migrateLegacyBookingState,
  reduceBookingDraft,
} from "../booking-draft.js";
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
    expect(declined.replacement).toBeNull();
    expect(declined.selectedSlot).toBeNull();
  });

  it("does not fabricate a service while normalizing legacy state", () => {
    expect(migrateLegacyBookingState({
      selectedAvailabilityDate: "2026-10-17",
    })).toMatchObject({ phase: "service", serviceAcceptance: null });

    const migrated = migrateLegacyBookingState({
      selectedAvailabilityDate: "2026-10-17",
      recoveredService: {
        id: "svc-1",
        name: "Consultation",
        source: "catalog",
      },
    });
    expect(migrated).toMatchObject({
      phase: "service",
      serviceAcceptance: {
        status: "pending",
        service: { id: "svc-1" },
      },
      selectedDate: null,
    });
  });

  it("migrates an accepted consultation checkpoint idempotently", () => {
    const malformed = {
      ...createEmptyBookingDraft(),
      version: 7,
      serviceAcceptance: {
        status: "accepted",
        service: undefined,
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "answered", value: "потрібен час" },
      contactId: "contact-1",
    } as never;
    const context = {
      historyText: ["Бажаєте записатися на консультацію?", "Так"],
      contactId: "contact-1",
    };
    const migrated = migrateLegacyBookingState({ bookingDraft: malformed }, context);
    const repeated = migrateLegacyBookingState({ bookingDraft: migrated }, context);

    expect(migrated).toMatchObject({
      version: 7,
      phase: "ready",
      serviceAcceptance: {
        status: "accepted",
        service: { id: CONSULTATION_SERVICE_ID, source: "direct" },
      },
      selectedDate: "2026-10-17",
      selectedSlot,
      note: { status: "answered", value: "потрібен час" },
      contactId: "contact-1",
    });
    expect(repeated).toEqual(migrated);
  });

  it("keeps an unaccepted offer at service phase without downstream facts", () => {
    const migrated = migrateLegacyBookingState(
      {
        selectedAvailabilityDate: "2026-10-17",
        selectedSlot,
        bookingNoteStatus: "awaiting",
      },
      { historyText: ["Бажаєте записатися на консультацію?"] },
    );

    expect(migrated).toMatchObject({
      phase: "service",
      serviceAcceptance: {
        status: "pending",
        service: { id: CONSULTATION_SERVICE_ID },
      },
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
    });
  });
});

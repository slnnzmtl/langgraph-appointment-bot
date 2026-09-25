import { describe, expect, it } from "vitest";

import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";

describe("BookingDraft reducer", () => {
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
        snapshotId: "availability-1",
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
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "service_selected",
        service: { id: "svc-1", source: "catalog" },
        accepted: true,
      }),
      {
        type: "slot_selected",
        slot: {
          dateStart: "2026-10-17T11:30:00",
          dateEnd: "2026-10-17T12:00:00",
          label: "11:30",
        },
      },
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
    const recovered = reduceBookingDraft(draft, { type: "slot_invalidated", keepDate: false });

    expect(recovered.serviceAcceptance?.service.id).toBe("svc-1");
    expect(recovered.selectedSlot).toBeNull();
    expect(recovered.note.status).toBe("skipped");
  });

  it("preserves the replacement command and booking facts across cancellation", () => {
    const ready = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", source: "catalog" },
          accepted: true,
        }),
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
    const command = {
      action: "create" as const,
      payload: { serviceId: "svc-1", dateStart: "2026-10-17T11:30:00" },
      idempotencyKey: "create:1",
      expiresAt: Date.now() + 60_000,
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
        idempotencyKey: "cancel:existing-1",
        expiresAt: Date.now() + 60_000,
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
});

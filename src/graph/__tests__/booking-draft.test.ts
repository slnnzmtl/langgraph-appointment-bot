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

  it("invalidates only the slot after an availability refresh", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
        label: "11:30",
      },
    });
    const recovered = reduceBookingDraft(draft, { type: "slot_invalidated", keepDate: false });

    expect(recovered.serviceAcceptance).toBeNull();
    expect(recovered.selectedSlot).toBeNull();
    expect(recovered.note.status).toBe("unasked");
  });
});

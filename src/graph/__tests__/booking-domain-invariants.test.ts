/**
 * DDD-272 Phase 0: four current architectural invariants (passing against today's code).
 */
import { describe, expect, it } from "vitest";

import {
  bookingDraftCanPresentAvailability,
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import { createCommandFromBookingDraft } from "../agent-loop/booking-command.js";
import {
  classifyMeetingMutationToolMessage,
  mutationCommittedThisTurn,
} from "../agent-loop/protocol/mutation.js";
import {
  clearBookingOwnedInteraction,
  openCatalogDetourInteraction,
  reduceBookingSession,
} from "../booking-session.js";
import {
  BOOKING_INFORMATIONAL_TOOL_NAMES,
  filterBookingInformationalTools,
} from "../../tools/index.js";
import { ToolMessage } from "@langchain/core/messages";
import { clinicState, ownedContactContext } from "./agent-loop-fixtures.js";
import {
  addressAsideDuringTimeSelect,
  hoursAsideDuringDateSelect,
  multiFactCreatePatch,
  pausedHitlCheckpointMeta,
  sketchSessionAfterServiceAccepted,
} from "./fixtures/ddd-272-later-phase.js";
import {
  BOOKING_SESSION_SCHEMA_VERSION,
  nextBookingRequirement,
  type BookingDecision,
  type BookingEffect,
  type BookingInput,
  type BookingView,
  type PendingDecision,
  type PendingEffect,
  type UnderstoodBookingTurn,
} from "../booking-domain/index.js";

const slot = {
  dateStart: "2026-09-10T14:00:00",
  dateEnd: "2026-09-10T14:30:00",
  label: "10 вер · 14:00",
};

describe("DDD-272 booking-domain contracts (compile-only)", () => {
  it("exports schema version 2 and keeps nextBookingRequirement unusable", () => {
    expect(BOOKING_SESSION_SCHEMA_VERSION).toBe(2);
    expect(() =>
      nextBookingRequirement(sketchSessionAfterServiceAccepted(), {
        contactContextDirty: true,
        bookingContextDirty: true,
        availabilityVerified: false,
      }),
    ).toThrow(/DDD-273/);
  });

  it("keeps contract shapes assignable for later phases", () => {
    const decision: PendingDecision = {
      kind: "mutation_confirm",
      action: "create",
      effectId: "eff-1",
    };
    const effect: BookingEffect = {
      kind: "create_meeting",
      payload: { serviceId: "svc-1" },
    };
    const pending: PendingEffect = {
      id: "eff-1",
      expectedRevision: 1,
      effect,
      status: "prepared",
    };
    const view: BookingView = {
      replyText: "ok",
      card: { kind: "plain_text", text: "ok" },
    };
    const input: BookingInput = {
      source: "semantic_patch",
      patch: multiFactCreatePatch,
    };
    const tagged: BookingDecision = {
      tag: "mutation_confirm",
      session: sketchSessionAfterServiceAccepted(),
      pendingEffect: pending,
      view,
    };
    const turn: UnderstoodBookingTurn = hoursAsideDuringDateSelect;
    expect(decision.kind).toBe("mutation_confirm");
    expect(input.source).toBe("semantic_patch");
    expect(tagged.tag).toBe("mutation_confirm");
    expect(turn.informationalQuestion).toBeTruthy();
    expect(addressAsideDuringTimeSelect.informationalQuestion).toBeTruthy();
    expect(pausedHitlCheckpointMeta.resumeNodeName).toBe("booking__tools");
  });
});

describe("DDD-272 invariant: selectable slot requires availability provenance", () => {
  it("refuses DATE/TIME presentation without accepted create service or reschedule target", () => {
    expect(bookingDraftCanPresentAvailability(null)).toBe(false);
    expect(bookingDraftCanPresentAvailability(createEmptyBookingDraft())).toBe(false);

    const pendingService = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog" },
      accepted: false,
    });
    expect(bookingDraftCanPresentAvailability(pendingService)).toBe(false);

    const accepted = reduceBookingDraft(pendingService, { type: "service_accepted" });
    expect(bookingDraftCanPresentAvailability(accepted)).toBe(true);
  });

  it("does not persist a slot before accepted service + matching date", () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    const withoutDate = reduceBookingDraft(accepted, { type: "slot_selected", slot });
    expect(withoutDate.selectedSlot).toBeNull();

    const withDate = reduceBookingDraft(accepted, { type: "date_selected", date: "2026-09-10" });
    const withSlot = reduceBookingDraft(withDate, { type: "slot_selected", slot });
    expect(withSlot.selectedSlot).toEqual(slot);
  });
});

describe("DDD-272 invariant: no meeting mutation without prerequisites", () => {
  it("createCommandFromBookingDraft stays null until service, slot, note, and owned contact exist", () => {
    const partial = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog" },
      accepted: true,
    });
    expect(
      createCommandFromBookingDraft(clinicState({ bookingDraft: partial })),
    ).toBeNull();

    const withSlot = reduceBookingDraft(
      reduceBookingDraft(partial, { type: "date_selected", date: "2026-09-10" }),
      { type: "slot_selected", slot },
    );
    expect(
      createCommandFromBookingDraft(
        clinicState({
          bookingDraft: withSlot,
          contactContext: ownedContactContext(),
        }),
      ),
    ).toBeNull();

    const noted = reduceBookingDraft(withSlot, {
      type: "note_status",
      status: "skipped",
    });
    const linked = reduceBookingDraft(noted, {
      type: "contact_resolved",
      contactId: "contact-1",
    });
    const command = createCommandFromBookingDraft(
      clinicState({
        bookingDraft: linked,
        contactContext: ownedContactContext(),
      }),
    );
    expect(command?.action).toBe("create");
  });
});

describe("DDD-272 invariant: no success copy without committed evidence", () => {
  it("classifies awaitingConfirmation / declined / prose as non-committed", () => {
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "t1",
          name: "create_meeting",
        }),
      ),
    ).toBe("pending_confirmation");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ cancelled: true }),
          tool_call_id: "t2",
          name: "create_meeting",
        }),
      ),
    ).toBe("declined");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: "Готово! Запис створено.",
          tool_call_id: "t3",
          name: "create_meeting",
        }),
      ),
    ).toBe("failed");
    expect(
      mutationCommittedThisTurn([
        new ToolMessage({
          content: "Готово! Запис створено.",
          tool_call_id: "t4",
          name: "create_meeting",
        }),
      ]),
    ).toBe(false);
  });

  it("treats only tool JSON with a committed meeting entity as committed", () => {
    const committed = new ToolMessage({
      content: JSON.stringify({ id: "meeting-1", visitLabel: "10 вер · 14:00" }),
      tool_call_id: "t5",
      name: "create_meeting",
    });
    expect(classifyMeetingMutationToolMessage(committed)).toBe("committed");
    expect(mutationCommittedThisTurn([committed])).toBe(true);
  });
});

describe("DDD-272 invariant: informational FAQ path does not clear accepted facts", () => {
  it("booking informational allowlist excludes mutation tools", () => {
    expect([...BOOKING_INFORMATIONAL_TOOL_NAMES].sort()).toEqual([
      "get_service",
      "get_working_time",
      "list_services",
    ]);
    const names = filterBookingInformationalTools([
      { name: "list_services" },
      { name: "get_service" },
      { name: "get_working_time" },
      { name: "create_meeting" },
      { name: "cancel_meeting" },
      { name: "reschedule_meeting" },
      { name: "present_availability_slots" },
    ] as never).map((t: { name: string }) => t.name);
    expect(names).toEqual(["list_services", "get_service", "get_working_time"]);
  });

  it("catalog_detour keeps the accepted draft; clearing only drops the detour card", () => {
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", name: "Botox", source: "catalog" },
      accepted: true,
    });
    const withDate = reduceBookingDraft(accepted, {
      type: "date_selected",
      date: "2026-09-10",
    });
    const session = reduceBookingSession(
      { bookingDraft: withDate, pendingInteraction: null },
      { type: "service_unresolved" },
    );
    expect(session.pendingInteraction?.kind).toBe("catalog_detour");
    expect(session.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(session.bookingDraft?.selectedDate).toBe("2026-09-10");

    const cleared = clearBookingOwnedInteraction(session.pendingInteraction);
    expect(cleared).toBeNull();
    // Draft facts are independent of the interaction clear helper.
    expect(session.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-1");
    expect(openCatalogDetourInteraction("Повернутися до запису").kind).toBe(
      "catalog_detour",
    );
  });
});

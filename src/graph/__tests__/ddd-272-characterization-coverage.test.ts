/**
 * DDD-272 characterization: executable coverage of Linear high-risk paths
 * against today's production helpers. Later-phase fixtures remain data-only
 * (no skipped Phase 4 assertions).
 */
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  classifyMeetingMutationToolMessage,
  mutationCommittedThisTurn,
} from "../agent-loop/protocol/mutation.js";
import { createCommandFromBookingDraft } from "../agent-loop/booking-command.js";
import {
  bookingDraftCanPresentAvailability,
  createEmptyBookingDraft,
  nextMissingContactField,
  reduceBookingDraft,
} from "../booking-draft.js";
import { isCatalogEvidenceEligibleText } from "../booking-entry-policy.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import {
  clearBookingOwnedInteraction,
  openCatalogDetourInteraction,
  reduceBookingSession,
} from "../booking-session.js";
import { stickyContinueAgentId } from "../supervisor/routing-predicates.js";
import { MAIN_MENU_LABEL } from "../../shared/clinic-constants.js";
import {
  BOOKING_INFORMATIONAL_TOOL_NAMES,
  filterBookingInformationalTools,
} from "../../tools/index.js";
import {
  canonicalBookingDraft,
  clinicState,
  ownedContactContext,
} from "./agent-loop-fixtures.js";
import {
  addressAsideDuringTimeSelect,
  hoursAsideDuringDateSelect,
  multiFactCreatePatch,
  pausedHitlCheckpointMeta,
  sketchSessionAfterServiceAccepted,
} from "./fixtures/ddd-272-later-phase.js";
import { supervisorState } from "./supervisor-fixtures.js";

const selectedSlot = {
  dateStart: "2026-10-17T11:30:00",
  dateEnd: "2026-10-17T12:00:00",
  label: "11:30",
};

/**
 * Registry of high-risk paths → the executable characterization below.
 * Each entry must have at least one `it(...)` that imports and asserts
 * current production behavior (not a string-length checklist).
 */
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

describe("DDD-272 characterization coverage registry", () => {
  it("names every Linear high-risk path that this file exercises", () => {
    expect(HIGH_RISK_PATHS).toEqual([
      "consultation_vs_named_procedure",
      "availability_exact_nearest_empty_stale",
      "combined_date_time",
      "note_answered_skipped",
      "contacts_new_incomplete_linkable_occupied_ambiguous",
      "hitl_create_reschedule_cancel_outcomes",
      "replacement_booking",
      "faq_during_booking_sticky_catalog_detour",
      "visit_status_menu_abandon_handoff",
    ]);
  });
});

describe("DDD-272 path: consultation_vs_named_procedure", () => {
  it("accepts consultation only after explicit service_accepted; catalog service can skip pending", () => {
    const pendingConsult = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "consultation", name: "Консультація", source: "catalog" },
      accepted: false,
    });
    expect(pendingConsult.serviceAcceptance?.status).toBe("pending");
    expect(bookingDraftCanPresentAvailability(pendingConsult)).toBe(false);

    const acceptedConsult = reduceBookingDraft(pendingConsult, { type: "service_accepted" });
    expect(acceptedConsult.serviceAcceptance?.status).toBe("accepted");
    expect(bookingDraftCanPresentAvailability(acceptedConsult)).toBe(true);

    const named = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-botox", name: "Botox", source: "catalog" },
      accepted: true,
    });
    expect(named.serviceAcceptance?.status).toBe("accepted");
    expect(named.serviceAcceptance?.service.id).toBe("svc-botox");
  });

  it("treats catalog-evidence-eligible labels as named-procedure entry candidates", () => {
    expect(isCatalogEvidenceEligibleText("Botox")).toBe(true);
    expect(isCatalogEvidenceEligibleText(MAIN_MENU_LABEL)).toBe(false);
  });
});

describe("DDD-272 path: availability_exact_nearest_empty_stale", () => {
  it("refuses DATE/TIME presentation without accepted create service or reschedule target", () => {
    expect(bookingDraftCanPresentAvailability(null)).toBe(false);
    expect(bookingDraftCanPresentAvailability(createEmptyBookingDraft())).toBe(false);
  });

  it("resolves exact date text and keeps requested time out of CRM evidence until a slot matches", () => {
    const exact = resolveBookingScheduleRequest("16 жовтня", "2026-10-10");
    expect(exact?.kind).toBe("exact");
    if (exact?.kind === "exact") {
      expect(exact.date).toMatch(/^2026-10-/);
    }

    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1", name: "Візит" },
    });
    const requested = reduceBookingDraft(started, {
      type: "schedule_requested",
      date: "2026-10-16",
      preferredTime: "14:00",
    });
    expect(requested.selectedSlot).toBeNull();
    expect(requested.requestedTime).toEqual({ value: "14:00", status: "pending" });

    const unavailable = reduceBookingDraft(requested, { type: "requested_time_unavailable" });
    expect(unavailable.selectedDate).toBe("2026-10-16");
    expect(unavailable.requestedTime?.status).toBe("unavailable");
  });
});

describe("DDD-272 path: combined_date_time", () => {
  it("persists schedule_requested date+time without selecting a CRM slot", () => {
    const started = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: { id: "meeting-1" },
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
});

describe("DDD-272 path: note_answered_skipped", () => {
  it("opens visit_note after slot; answered and skipped both clear the note gate", () => {
    const withService = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-1", source: "catalog" },
      accepted: true,
    });
    const dated = reduceBookingDraft(withService, {
      type: "date_selected",
      date: "2026-10-17",
    });
    const slotted = reduceBookingDraft(dated, { type: "slot_selected", slot: selectedSlot });
    expect(slotted.phase).toBe("note");
    // Slot selection opens the note prompt (awaiting), not unasked.
    expect(slotted.note.status).toBe("awaiting");

    const answered = reduceBookingDraft(slotted, {
      type: "note_status",
      status: "answered",
      value: "allergy",
    });
    expect(answered.note).toEqual({ status: "answered", value: "allergy" });
    expect(answered.phase).toBe("details");

    const skipped = reduceBookingDraft(slotted, { type: "note_status", status: "skipped" });
    expect(skipped.note.status).toBe("skipped");
    expect(skipped.phase).toBe("details");
  });
});

describe("DDD-272 path: contacts_new_incomplete_linkable_occupied_ambiguous", () => {
  it("walks the contact ladder and refuses create until owned contact exists", () => {
    expect(nextMissingContactField({})).toBe("phoneNumber");
    expect(nextMissingContactField({ phoneNumber: "+380501112233" })).toBe("firstName");
    expect(
      nextMissingContactField({
        phoneNumber: "+380501112233",
        firstName: "Ada",
      }),
    ).toBe("lastName");
    expect(
      nextMissingContactField({
        phoneNumber: "+380501112233",
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).toBeNull();

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
      {
        type: "slot_selected",
        slot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
        },
      },
    );
    expect(
      createCommandFromBookingDraft(
        clinicState({
          bookingDraft: withSlot,
          contactContext: ownedContactContext(),
        }),
      ),
    ).toBeNull();

    const noted = reduceBookingDraft(withSlot, { type: "note_status", status: "skipped" });
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
    expect(command?.payload).toMatchObject({
      serviceId: "svc-1",
      contactId: "contact-1",
    });
  });
});

describe("DDD-272 path: hitl_create_reschedule_cancel_outcomes", () => {
  it("classifies mutation tool outcomes and only treats committed entity JSON as success", () => {
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

    const committed = new ToolMessage({
      content: JSON.stringify({ id: "meeting-1", visitLabel: "10 вер · 14:00" }),
      tool_call_id: "t5",
      name: "create_meeting",
    });
    expect(classifyMeetingMutationToolMessage(committed)).toBe("committed");
    expect(mutationCommittedThisTurn([committed])).toBe(true);
  });

  it("documents paused HITL resume target for Phase 5/6A (fixture data only)", () => {
    expect(pausedHitlCheckpointMeta).toMatchObject({
      interruptType: "confirm_booking",
      resumeNodeName: "booking__tools",
      expectedRecovery: "expired_confirmation",
    });
  });
});

describe("DDD-272 path: replacement_booking", () => {
  it("preserves originalCommand across cancel→create_pending and clears on decline", () => {
    const readyWithSlot = reduceBookingDraft(
      reduceBookingDraft(
        reduceBookingDraft(createEmptyBookingDraft(), {
          type: "service_selected",
          service: { id: "svc-1", source: "catalog" },
          accepted: true,
        }),
        { type: "date_selected", date: "2026-10-17" },
      ),
      { type: "slot_selected", slot: selectedSlot },
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
        dateStart: selectedSlot.dateStart,
        dateEnd: selectedSlot.dateEnd,
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

    const createPending = reduceBookingDraft(
      reduceBookingDraft(offered, {
        type: "cancel_existing_requested",
        command: { action: "cancel", payload: { meetingId: "existing-1" } },
      }),
      { type: "cancel_existing_completed" },
    );
    expect(createPending.replacement?.status).toBe("create_pending");
    expect(createPending.replacement?.originalCommand).toEqual(command);

    expect(reduceBookingDraft(offered, { type: "cancel_existing_declined" })).toBeNull();
  });
});

describe("DDD-272 path: faq_during_booking_sticky_catalog_detour", () => {
  it("keeps accepted draft facts under catalog_detour; informational allowlist excludes mutations", () => {
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
    expect(session.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-1");
    expect(openCatalogDetourInteraction("Повернутися до запису").kind).toBe(
      "catalog_detour",
    );
  });

  it("routes FAQ catalog chips to FAQ while a booking interaction is preserved", () => {
    expect(
      stickyContinueAgentId(
        supervisorState({
          messages: [new HumanMessage("Ботулінотерапія")],
          pendingInteraction: {
            kind: "service_candidate",
            owner: "faq",
            utterance: "процедури",
            choices: [
              { id: "svc-b", label: "Ботулінотерапія", serviceIds: ["svc-b"] },
              { id: "svc-c", label: "Консультація", serviceIds: ["svc-c"] },
            ],
          },
          bookingDraft: canonicalBookingDraft({
            note: { status: "awaiting" },
            phase: "note",
          }),
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyText: "Оберіть послугу зі списку",
            replyButtons: ["Ботулінотерапія", "Консультація"],
          },
        }),
      ),
    ).toBe("faq");
  });
});

describe("DDD-272 path: visit_status_menu_abandon_handoff", () => {
  it("closes the session on draft_abandoned and does not sticky-continue main menu", () => {
    const draft = canonicalBookingDraft();
    const abandoned = reduceBookingDraft(draft, { type: "draft_abandoned" });
    expect(abandoned).toBeNull();

    expect(
      stickyContinueAgentId(
        supervisorState({
          bookingDraft: draft,
          messages: [new HumanMessage(MAIN_MENU_LABEL)],
          lastHandoff: {
            agentId: "booking",
            agentName: "booking",
            status: "ok",
            replyText: "ok",
            replyButtons: [MAIN_MENU_LABEL],
          },
        }),
      ),
    ).not.toBe("booking");
  });

  it("keeps owned contact context available for visit-status style reads", () => {
    const owned = ownedContactContext();
    expect(owned.ownership).toBe("telegram");
    expect(owned.contacts[0]?.id).toBe("contact-1");
    expect(clinicState({ contactContext: owned }).contactContext?.ownership).toBe("telegram");
  });
});

describe("DDD-272 later-phase fixtures (data only)", () => {
  it("exposes reusable fixtures without asserting Phase 4 resume-loop behavior", () => {
    expect(multiFactCreatePatch.serviceIntent?.kind).toBe("named_procedure");
    expect(multiFactCreatePatch.scheduleIntent?.kind).toBe("date_and_time");
    expect(multiFactCreatePatch.contactFacts?.phoneNumber).toMatch(/^\+/);
    expect(hoursAsideDuringDateSelect.informationalQuestion).toBeTruthy();
    expect(addressAsideDuringTimeSelect.informationalQuestion).toBeTruthy();
    expect(sketchSessionAfterServiceAccepted().schemaVersion).toBe(2);
  });
});

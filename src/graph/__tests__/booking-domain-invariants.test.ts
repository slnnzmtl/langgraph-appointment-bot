/**
 * Atomic cutover invariants: decide never returns a draft; informational tools stay bound-only.
 */
import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";

import {
  BOOKING_INFORMATIONAL_TOOL_NAMES,
  filterBookingInformationalTools,
} from "../../tools/index.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking/booking-draft.js";
import { decideBooking } from "../booking-domain/decide.js";
import { nextBookingRequirement } from "../booking-domain/requirement.js";
import {
  classifyMeetingMutationToolMessage,
  mutationCommittedThisTurn,
} from "../agent-loop/protocol/mutation.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";

describe("atomic booking-domain invariants", () => {
  it("decideBooking returns events + decision, never a modified draft", () => {
    const result = decideBooking(
      null,
      { source: "semantic_patch", patch: { serviceIntent: { kind: "consultation" } } },
      {
        clinicDay: "2026-09-01",
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      },
    );
    expect(Object.keys(result).sort()).toEqual(["decision", "events"]);
    expect(result).not.toHaveProperty("draft");
    expect(result).not.toHaveProperty("session");
    expect(result.decision).not.toHaveProperty("replyText");
    expect(result.events.some((e) => e.type === "service_selected")).toBe(true);
    const selected = result.events.find((e) => e.type === "service_selected");
    if (selected?.type === "service_selected") {
      expect(selected.service.id).toBe(CONSULTATION_SERVICE_ID);
    }
  });

  it("nextBookingRequirement derives from the draft only", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
      accepted: true,
    });
    expect(nextBookingRequirement(draft, {
      contactContextDirty: true,
      bookingContextDirty: true,
      availabilityVerified: false,
    })).toBe("date");
  });

  it("filters booking bind tools to informational reads only", () => {
    const tools = [
      { name: "list_services" },
      { name: "get_service" },
      { name: "get_working_time" },
      { name: "create_meeting" },
      { name: "present_availability_slots" },
    ] as never[];
    const informational = filterBookingInformationalTools(tools).map((t: { name: string }) => t.name);
    expect(informational).toEqual([...BOOKING_INFORMATIONAL_TOOL_NAMES]);
  });

  it("mutationCommittedThisTurn requires a committed meeting tool message", () => {
    expect(mutationCommittedThisTurn([])).toBe(false);
    expect(
      mutationCommittedThisTurn([
        new ToolMessage({
          content: JSON.stringify({ id: "m-1", ok: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(true);
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("pending_confirmation");
  });
});

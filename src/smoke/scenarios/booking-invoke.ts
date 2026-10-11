import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import {
  expectCalled,
  expectInteraction,
  expectNotCalled,
  SmokeAssertError,
} from "../assert.js";
import { writeTelegramId } from "../env.js";
import { openBookingSession } from "./booking-helpers.js";
import type { CallRecord, SmokeScenario } from "../types.js";

/** MCP writes that must never run in this read-only booking invoke smoke. */
const FORBIDDEN_MCP_WRITES = [
  "create_contact",
  "update_entity",
  "create_meeting",
  "update_meeting",
] as const;

const assertNoWrites = (label: string, calls: CallRecord[]): void => {
  expectNotCalled(label, calls, [...FORBIDDEN_MCP_WRITES]);
};

export const bookingFreeTextTypedSlotScenario: SmokeScenario = {
  name: "booking-free-text-typed-slot",
  tier: "invoke",
  run: async (ctx) => {
    const telegramId = writeTelegramId("g");
    const bundle = openBookingSession(ctx, "booking-free-text-typed-slot", telegramId);
    try {
      const opened = await bundle.session.say(
        "Доброго дня. Можливо записатися на прийом?",
      );
      expectInteraction(
        "booking-free-text-typed-slot open",
        opened.state.pendingInteraction?.kind,
        "service_confirm",
      );
      const pendingService = opened.state.bookingDraft?.serviceAcceptance;
      if (
        pendingService?.status !== "pending"
        || pendingService.service.id !== CONSULTATION_SERVICE_ID
      ) {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: expected pending consultation, got ${JSON.stringify(pendingService)}`,
        );
      }
      expectNotCalled(
        "booking-free-text-typed-slot open availability",
        opened.calls,
        "present_availability_slots",
      );
      assertNoWrites("booking-free-text-typed-slot open", opened.calls);

      const accepted = await bundle.session.say("Так");
      if (accepted.state.bookingDraft?.serviceAcceptance?.status !== "accepted") {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: service was not accepted after Так",
        );
      }
      if (accepted.state.bookingDraft == null) {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: bookingDraft null after Так",
        );
      }
      const afterAcceptKind = accepted.state.pendingInteraction?.kind;
      if (afterAcceptKind !== "date_select" && afterAcceptKind !== "time_select") {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: expected DATE/TIME after Так, got ${afterAcceptKind ?? "null"}`,
        );
      }
      // present_availability_slots is a graph tool; smoke records MCP only.
      // get_working_time proves the availability CRM path ran after Так.
      expectCalled(
        "booking-free-text-typed-slot Так availability",
        accepted.calls,
        "get_working_time",
      );
      if (accepted.state.availabilityContext == null) {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: availabilityContext missing after Так (present_availability_slots)",
        );
      }
      assertNoWrites("booking-free-text-typed-slot Так", accepted.calls);

      let dated = accepted;
      if (dated.state.pendingInteraction?.kind === "date_select") {
        const dayChoice = dated.state.pendingInteraction.choices.find(
          (choice) => choice.id !== "other_date"
            && choice.id !== "earlier"
            && choice.id !== "later",
        );
        if (dayChoice == null) {
          throw new SmokeAssertError(
            "booking-free-text-typed-slot: no day choice on DATE interaction",
          );
        }
        dated = await bundle.session.say(dayChoice.label);
        if (dated.state.bookingDraft?.selectedDate !== dayChoice.id) {
          throw new SmokeAssertError(
            `booking-free-text-typed-slot: selectedDate=${dated.state.bookingDraft?.selectedDate ?? "null"} expected ${dayChoice.id}`,
          );
        }
        assertNoWrites("booking-free-text-typed-slot date", dated.calls);
      }

      if (dated.state.pendingInteraction?.kind !== "time_select") {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: expected TIME after date, got ${dated.state.pendingInteraction?.kind ?? "null"}`,
        );
      }
      const timeInteraction = dated.state.pendingInteraction;
      const selectedDate = dated.state.bookingDraft?.selectedDate;
      if (selectedDate == null || timeInteraction.date !== selectedDate) {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: TIME date ${timeInteraction.date} != draft ${selectedDate ?? "null"}`,
        );
      }
      const slotChoice = timeInteraction.choices.find(
        (choice) => choice.id !== "other_date"
          && choice.id !== "earlier"
          && choice.id !== "later",
      );
      if (slotChoice == null) {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: no slot choice on TIME interaction",
        );
      }
      const snapshotDay = timeInteraction.snapshot.days.find(
        (day) => day.date === timeInteraction.date,
      );
      const expectedSlot = snapshotDay?.slots.find((entry) => entry.id === slotChoice.id);
      if (expectedSlot == null) {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: slotChoice.id ${slotChoice.id} missing from snapshot day ${timeInteraction.date}`,
        );
      }
      const priorTimePrompt = dated.reply;
      const noted = await bundle.session.say(slotChoice.label);
      if (noted.state.pendingInteraction?.kind !== "visit_note") {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: expected visit_note, got ${noted.state.pendingInteraction?.kind ?? "null"}`,
        );
      }
      const slot = noted.state.bookingDraft?.selectedSlot;
      if (slot == null) {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: selectedSlot missing after slot say()",
        );
      }
      if (slot.dateStart !== expectedSlot.dateStart || slot.dateEnd !== expectedSlot.dateEnd) {
        throw new SmokeAssertError(
          `booking-free-text-typed-slot: selectedSlot ${slot.dateStart}–${slot.dateEnd} != snapshot ${expectedSlot.dateStart}–${expectedSlot.dateEnd}`,
        );
      }
      if (noted.reply === priorTimePrompt) {
        throw new SmokeAssertError(
          "booking-free-text-typed-slot: TIME prompt was repeated after slot selection",
        );
      }
      assertNoWrites("booking-free-text-typed-slot slot", noted.calls);
      console.log("✓ booking-free-text-typed-slot: stopped at visit_note with no CRM writes");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

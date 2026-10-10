import {
  BOOKING_OFFER_MENU,
  SERVICE_CANDIDATE_OTHER_LABEL_UK,
} from "../../shared/clinic-constants.js";
import { SmokeAssertError } from "../assert.js";
import type { SmokeSession, TurnResult } from "../harness.js";

export const isConsultationName = (name: string): boolean =>
  /консультац/i.test(name.trim());

const hasBookingOfferKeyboard = (buttons: string[]): boolean =>
  buttons.includes(BOOKING_OFFER_MENU[0]) && buttons.includes(BOOKING_OFFER_MENU[1]);

/** Drive until the consultation / procedure BOOKING OFFER keyboard is visible. */
export const openBookingOffer = async (
  session: SmokeSession,
  label: string,
  maxTurns = 4,
): Promise<TurnResult> => {
  let turn = await session.say("Записатись");
  for (let i = 0; i < maxTurns; i += 1) {
    if (hasBookingOfferKeyboard(turn.buttons)) {
      return turn;
    }
    if (i === maxTurns - 1) {
      break;
    }
    turn = await session.say("Записатись на консультацію");
  }
  throw new SmokeAssertError(
    `${label}: never opened BOOKING OFFER keyboard (buttons=[${turn.buttons.join(" | ") || "none"}])`,
  );
};

/** Drill FAQ catalog until a non-consultation service_confirm is open. */
export const drillToProcedureOffer = async (
  session: SmokeSession,
  label: string,
  maxTaps = 8,
): Promise<TurnResult> => {
  let turn = await session.tap(BOOKING_OFFER_MENU[1]);
  for (let i = 0; i < maxTaps; i += 1) {
    const interaction = turn.state.pendingInteraction;
    if (interaction?.kind === "service_confirm") {
      if (!isConsultationName(interaction.service.name ?? "")) {
        return turn;
      }
      // Consultation confirm mid-drill — choose other again.
      if (turn.buttons.includes(BOOKING_OFFER_MENU[1])) {
        turn = await session.tap(BOOKING_OFFER_MENU[1]);
        continue;
      }
    }
    if (interaction?.kind === "service_candidate") {
      if (turn.buttons.includes(SERVICE_CANDIDATE_OTHER_LABEL_UK) && i === maxTaps - 1) {
        turn = await session.tap(SERVICE_CANDIDATE_OTHER_LABEL_UK);
        continue;
      }
      const next = interaction.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && !isConsultationName(choice.label)
          && turn.buttons.includes(choice.label),
      );
      const fallback = interaction.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && turn.buttons.includes(choice.label),
      );
      const pick = next ?? fallback;
      if (pick) {
        turn = await session.tap(pick.label);
        continue;
      }
    }
    break;
  }
  throw new SmokeAssertError(
    `${label}: never reached non-consultation service_confirm (pending=${turn.state.pendingInteraction?.kind ?? "null"})`,
  );
};

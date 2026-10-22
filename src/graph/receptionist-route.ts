/**
 * Pure routing from an UnderstoodBookingTurn + session presence.
 * Replaces supervisor next/reply/menu as workflow authority after ingress interpret.
 */

import type { UnderstoodBookingTurn } from "./booking-domain/turn.js";
import type { BookingDraft } from "./booking-draft.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID, FINISH_ROUTE, type ClinicRouteId } from "./types.js";

export type ReceptionistRoute =
  | { kind: "booking"; patch: UnderstoodBookingTurn }
  | { kind: "faq_capability"; patch: UnderstoodBookingTurn }
  | { kind: "main_menu" }
  | { kind: "visit_status"; patch: UnderstoodBookingTurn }
  | { kind: "help" }
  | { kind: "greeting" }
  | { kind: "clarification"; patch: UnderstoodBookingTurn };

export const hasOpenBookingSession = (
  draft: BookingDraft | null | undefined,
): boolean =>
  draft != null
  && (
    draft.bookingAttemptId != null
    || draft.serviceAcceptance != null
    || draft.rescheduleTarget != null
    || draft.replacement != null
    || draft.pendingCommand != null
    || draft.deferredTurn != null
    || draft.pendingEffect != null
    || draft.pendingDecision != null
  );

const hasBookingFacts = (patch: UnderstoodBookingTurn): boolean =>
  patch.serviceIntent != null
  || patch.scheduleIntent != null
  || patch.note != null
  || patch.contactFacts != null
  || patch.contactFormatError != null
  || patch.choice != null
  || patch.informationalQuestion != null;

/**
 * Route one already-understood turn. Deterministic chips are expected to be
 * resolved into the patch before this runs.
 */
export const routeUnderstoodTurn = (
  patch: UnderstoodBookingTurn,
  draft: BookingDraft | null | undefined,
): ReceptionistRoute => {
  const open = hasOpenBookingSession(draft);
  const control = patch.controlIntent?.kind;

  if (control === "main_menu") {
    return { kind: "main_menu" };
  }
  if (control === "visit_status") {
    return { kind: "visit_status", patch };
  }
  if (control === "greeting") {
    return open ? { kind: "booking", patch } : { kind: "greeting" };
  }
  if (control === "help") {
    return open ? { kind: "booking", patch } : { kind: "help" };
  }
  if (
    control === "visit_cancel"
    || control === "visit_reschedule"
    || control === "abandon"
    || control === "human_handoff"
    || control === "hitl_yes"
    || control === "hitl_no"
    || control === "return_to_booking"
  ) {
    return { kind: "booking", patch };
  }

  // Idle hours/address/price stay FAQ reads — even when the model also tagged a
  // serviceIntent (e.g. «Скільки коштує консультація?»). Must not open REPLACE.
  const idleInformational =
    patch.informationalQuestion != null
    || patch.faqTopic === "hours"
    || patch.faqTopic === "address"
    || patch.faqTopic === "price"
    || patch.idleFaq != null;
  if (
    !open
    && idleInformational
    && patch.scheduleIntent == null
    && patch.note == null
    && patch.contactFacts == null
    && patch.contactFormatError == null
    && patch.choice == null
    && patch.controlIntent == null
  ) {
    return { kind: "faq_capability", patch };
  }
  // Catalog browse with no session is FAQ capability (does not start booking).
  if (!open && patch.serviceIntent?.kind === "catalog_browse" && patch.scheduleIntent == null) {
    return { kind: "faq_capability", patch };
  }

  if (open || hasBookingFacts(patch)) {
    // Idle FAQ text while booking is open is a side question on the kernel.
    if (patch.idleFaq != null && patch.informationalQuestion == null) {
      return {
        kind: "booking",
        patch: {
          ...patch,
          informationalQuestion: patch.idleFaq.question,
          faqTopic: patch.idleFaq.topic,
        },
      };
    }
    return { kind: "booking", patch };
  }

  if (patch.idleFaq != null || patch.faqTopic != null) {
    return { kind: "faq_capability", patch };
  }

  if (Object.keys(patch).length === 0) {
    return { kind: "greeting" };
  }

  return { kind: "clarification", patch };
};

/** Graph edge target for a receptionist route (compile / supervisor). */
export const clinicRouteForReceptionist = (
  route: ReceptionistRoute,
): ClinicRouteId => {
  switch (route.kind) {
    case "booking":
      return BOOKING_AGENT_ID;
    case "faq_capability":
      return FAQ_AGENT_ID;
    case "main_menu":
    case "visit_status":
    case "help":
    case "greeting":
    case "clarification":
      return FINISH_ROUTE;
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
};

import { trackEvent } from "../../analytics/track.js";
import type { SupervisorIntent } from "../routing.js";
import type { ClinicStateUpdate } from "../state.js";

export type SupervisorRoutingPath =
  | "chip"
  | "sticky"
  | "faq_predicate"
  | "named_booking_refine"
  | "status_pre_llm"
  | "pending_reschedule"
  | "abandon"
  | "main_menu"
  | "services_guide"
  | "llm"
  | "llm_choice"
  | "llm_status"
  | "llm_picker"
  | "llm_intent_override"
  | "llm_abandon"
  | "routing_failure";

export type SupervisorRoutingTelemetry = {
  path: SupervisorRoutingPath;
  intent?: SupervisorIntent;
  choiceId?: string;
  choiceAccepted?: boolean;
  regexStatusSignal?: boolean;
  next?: string;
  draftDiscarded?: boolean;
  /** Model `book` needed CRM evidence but catalog load failed/empty. */
  catalogUnavailable?: boolean;
};

export type RouteOutcome = {
  path: SupervisorRoutingPath;
  update: ClinicStateUpdate;
  draftDiscarded?: boolean;
  choiceAccepted?: boolean;
};

export const emitSupervisorRoutingDecision = (
  props: SupervisorRoutingTelemetry,
): void => {
  const payload = Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== undefined),
  );
  trackEvent("supervisor_routing_decision", payload);
};

/**
 * Bounded semantic patch for one patient turn (contract Phase 0; apply Phase 4).
 * Not a singular workflowInput and not an event bus.
 */

export type ServiceIntent =
  | { kind: "consultation" }
  | { kind: "named_procedure"; query: string; serviceId?: string }
  | { kind: "catalog_browse"; query?: string }
  | { kind: "confirm_pending_service" }
  | { kind: "decline_pending_service" };

export type ScheduleIntent =
  | { kind: "date"; date: string }
  | { kind: "time"; time: string }
  | { kind: "date_and_time"; date: string; time: string }
  | { kind: "relative"; queryKind: "nearest" | "earlier" | "later"; anchor?: string }
  | { kind: "choice"; choiceId: string };

export type NoteInput =
  | { kind: "answer"; value: string }
  | { kind: "skip" };

export type ContactPatch = {
  phoneNumber?: string;
  firstName?: string;
  lastName?: string;
};

export type SemanticChoice = {
  choiceId: string;
  /** Exact chip / alias text when resolved from UI. */
  label?: string;
};

export type ControlIntent =
  | { kind: "main_menu" }
  | { kind: "abandon" }
  | { kind: "human_handoff" }
  | { kind: "hitl_yes" }
  | { kind: "hitl_no" }
  | { kind: "return_to_booking" }
  | { kind: "visit_status" };

/**
 * Canonical application order (Phase 4):
 * 1. controlIntent
 * 2. explicit service change
 * 3. scheduleIntent
 * 4. note
 * 5. contactFacts
 * 6. informationalQuestion (read-only FAQ; resume derived view)
 */
export type UnderstoodBookingTurn = {
  serviceIntent?: ServiceIntent;
  scheduleIntent?: ScheduleIntent;
  note?: NoteInput;
  contactFacts?: Partial<ContactPatch>;
  choice?: SemanticChoice;
  informationalQuestion?: string;
  controlIntent?: ControlIntent;
};

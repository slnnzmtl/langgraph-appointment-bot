/**
 * Bounded semantic patch for one patient turn.
 * Not a singular workflowInput and not an event bus.
 */

export type ServiceIntent =
  | { kind: "consultation" }
  | { kind: "named_procedure"; query: string }
  | { kind: "catalog_browse"; query?: string }
  | { kind: "confirm_pending_service" }
  | { kind: "decline_pending_service" }
  /**
   * Idle FAQ unique highlight: book that CRM row. Supervisor rewrites to
   * catalog_service only when the id is on the current allowlisted list.
   * Never selects consultation in the kernel.
   */
  | { kind: "book_highlighted" }
  /** Resolved from catalog evidence only (never model-minted CRM ids). */
  | { kind: "catalog_service"; serviceId: string; serviceName?: string; durationMinutes?: number };

export type ScheduleIntent =
  | { kind: "date"; date: string }
  | { kind: "time"; time: string }
  | { kind: "date_and_time"; date: string; time: string }
  | { kind: "relative"; queryKind: "nearest" | "earlier" | "later"; anchor?: string }
  | { kind: "choice"; choiceId: string }
  | {
      kind: "slot";
      slot: { dateStart: string; dateEnd: string; label: string };
      snapshotId?: string;
    };

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

export type FaqTopicHint =
  | "hours"
  | "address"
  | "price"
  | "catalog"
  | "other";

/**
 * Idle clinic question when no booking session owns the turn.
 * Distinct from {@link UnderstoodBookingTurn.informationalQuestion} which is a
 * side question during an active booking.
 */
export type IdleFaqIntent = {
  question: string;
  topic: FaqTopicHint;
};

export type ControlIntent =
  | { kind: "main_menu" }
  | { kind: "abandon" }
  | { kind: "human_handoff" }
  | { kind: "hitl_yes" }
  | { kind: "hitl_no" }
  | { kind: "return_to_booking" }
  | { kind: "visit_status" }
  | { kind: "visit_cancel" }
  | { kind: "visit_reschedule" }
  | { kind: "greeting" }
  | { kind: "help" };

/**
 * Canonical application order:
 * 1. controlIntent
 * 2. explicit service change
 * 3. scheduleIntent
 * 4. note
 * 5. contactFacts
 * 6. informationalQuestion / idleFaq (read-only; resume derived view)
 */
export type UnderstoodBookingTurn = {
  serviceIntent?: ServiceIntent;
  scheduleIntent?: ScheduleIntent;
  note?: NoteInput;
  contactFacts?: Partial<ContactPatch>;
  /**
   * Open contact field received non-empty text that failed structural shape.
   * Decide re-asks the same field with clarificationReason; not a submitted fact.
   */
  contactFormatError?: "phoneNumber" | "firstName" | "lastName";
  choice?: SemanticChoice;
  /** Side question during an active booking (hours/address/price/other). */
  informationalQuestion?: string;
  /** Topic hint for informationalQuestion or idle FAQ. */
  faqTopic?: FaqTopicHint;
  /** Idle clinic FAQ when no booking session is open. */
  idleFaq?: IdleFaqIntent;
  controlIntent?: ControlIntent;
};

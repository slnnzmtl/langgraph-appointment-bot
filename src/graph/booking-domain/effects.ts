/**
 * Effect correlation and typed CRM/tool outcomes (atomic cutover).
 * Command idempotency — not event sourcing.
 */

export type BookingEffect =
  | {
      kind: "present_availability";
      queryKind: "exact" | "nearest" | "earlier" | "later";
      date?: string;
      preferredTime?: string;
      /** When true, this is an exact-slot revalidation before mutation. */
      revalidate?: boolean;
    }
  | { kind: "lookup_contact_by_phone"; phoneNumber: string }
  | {
      kind: "create_contact";
      payload: {
        phoneNumber: string;
        firstName: string;
        lastName: string;
      };
    }
  | {
      kind: "update_contact";
      payload: {
        contactId: string;
        phoneNumber?: string;
        firstName?: string;
        lastName?: string;
      };
    }
  | { kind: "link_telegram_contact"; contactId: string } // tool: link_telegram_to_contact
  | {
      kind: "create_meeting";
      payload: {
        serviceId: string;
        contactId: string;
        dateStart: string;
        dateEnd: string;
        name: string;
        confirmMessage: string;
        description?: string;
      };
    }
  | {
      kind: "reschedule_meeting";
      payload: {
        meetingId: string;
        dateStart: string;
        dateEnd: string;
        confirmMessage: string;
        name?: string;
      };
    }
  | {
      kind: "cancel_meeting";
      payload: Readonly<Record<string, unknown>>;
    }
  | { kind: "list_services"; query?: string }
  | { kind: "get_service"; serviceId: string }
  | { kind: "get_working_time" };

export type PendingEffectStatus = "prepared" | "executing" | "completed" | "unknown";

export type PendingEffect = {
  id: string;
  expectedRevision: number;
  effect: BookingEffect;
  status: PendingEffectStatus;
};

/** Allowlisted informational facts a side-question effect may surface. */
export type InformationalFacts = {
  hours?: string;
  address?: string;
  servicePrice?: string;
  serviceId?: string;
  serviceName?: string;
};

/** Allowlisted slot/date choice for patient cards (no raw tool body). */
export type AvailabilityPresentationChoice = {
  id: string;
  label: string;
  date?: string;
};

export type EffectResult =
  | {
      effectId: string;
      kind: "availability";
      outcome: "slots" | "empty" | "closed" | "stale" | "error";
      slotIds?: string[];
      /** Present when a presented slot was confirmed still free. */
      verifiedSlotId?: string;
      snapshotId?: string;
      /** date_select vs time_select derived from open days + draft selectedDate. */
      presentationMode?: "date_select" | "time_select";
      /** Allowlisted ids+labels only. */
      presentationChoices?: AvailabilityPresentationChoice[];
      /** Day scoped when presentationMode is time_select. */
      presentationDate?: string;
    }
  | {
      effectId: string;
      kind: "contact_lookup";
      outcome: "none" | "single_linkable" | "occupied" | "ambiguous" | "error";
      contactIds?: string[];
      /** Authoritative phone from the pending effect (not draft / tool args). */
      phoneNumber?: string;
    }
  | {
      effectId: string;
      kind: "contact_write";
      outcome: "created" | "updated" | "linked" | "failed" | "error";
      contactId?: string;
      /** True when CRM missingFields is empty after the write. */
      crmComplete?: boolean;
    }
  | {
      effectId: string;
      kind: "mutation";
      action: "create" | "reschedule" | "cancel";
      outcome:
        | "committed"
        | "declined"
        | "pending"
        | "failed"
        | "malformed"
        | "unknown";
    }
  | {
      effectId: string;
      kind: "informational";
      outcome: "ok" | "error";
      /** Allowlisted facts only — never raw tool text. */
      facts?: InformationalFacts;
    }
  | {
      effectId: string;
      kind: "catalog";
      outcome: "ok" | "error" | "empty";
      /** Allowlisted catalog rows only (id + display name). */
      services?: Array<{ id: string; name: string }>;
    };

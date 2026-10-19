/**
 * Effect correlation and typed CRM/tool outcomes (contract Phase 0; enforce Phase 2).
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
      payload: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "reschedule_meeting";
      payload: Readonly<Record<string, unknown>>;
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

export type EffectResult =
  | {
      effectId: string;
      kind: "availability";
      outcome: "slots" | "empty" | "closed" | "stale" | "error";
      slotIds?: string[];
      /** Present when a presented slot was confirmed still free. */
      verifiedSlotId?: string;
      snapshotId?: string;
    }
  | {
      effectId: string;
      kind: "contact_lookup";
      outcome: "none" | "single_linkable" | "occupied" | "ambiguous" | "error";
      contactIds?: string[];
    }
  | {
      effectId: string;
      kind: "contact_write";
      outcome: "created" | "updated" | "linked" | "failed" | "error";
      contactId?: string;
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
    };

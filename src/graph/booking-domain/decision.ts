import type { EffectResult, PendingEffect } from "./effects.js";
import type { BookingSessionV2, PendingDecision } from "./session.js";
import type { UnderstoodBookingTurn } from "./turn.js";

/**
 * Outputs of decideBooking (Phase 2). Graph adapters map these to nodes until Phase 5.
 */

export type BookingViewCard =
  | { kind: "service_confirm"; serviceId: string; labels: string[] }
  | { kind: "service_candidate"; choiceIds: string[] }
  | { kind: "date_select"; snapshotId: string; choiceIds: string[] }
  | { kind: "time_select"; date: string; snapshotId: string; choiceIds: string[] }
  | { kind: "visit_note"; skipLabel: string }
  | { kind: "contact_field"; field: "phoneNumber" | "firstName" | "lastName" }
  | {
      kind: "visit_select";
      stage: "action" | "meeting" | "replacement";
      choiceIds: string[];
    }
  | { kind: "mutation_confirm"; action: "create" | "reschedule" | "cancel"; effectId: string }
  | { kind: "clarification"; reason: string }
  | { kind: "plain_text"; text: string };

export type BookingView = {
  replyText: string;
  replyButtons?: string[];
  card: BookingViewCard | null;
};

export type BookingDecision =
  | {
      tag: "ask";
      session: BookingSessionV2;
      view: BookingView;
      pendingDecision: PendingDecision;
    }
  | {
      tag: "effect";
      session: BookingSessionV2;
      pendingEffect: PendingEffect;
    }
  | {
      tag: "reply";
      session: BookingSessionV2;
      view: BookingView;
    }
  | {
      tag: "mutation_confirm";
      session: BookingSessionV2;
      pendingEffect: PendingEffect;
      view: BookingView;
    }
  | {
      tag: "terminal";
      session: BookingSessionV2 | null;
      view: BookingView;
      reason: "abandon" | "handoff" | "menu" | "success" | "failed";
    };

/** CRM / availability read models passed into decideBooking (not a second aggregate). */
export type BookingReadModels = {
  contactContextDirty: boolean;
  bookingContextDirty: boolean;
  availabilityVerified: boolean;
};

/**
 * Interpreter / patient / effect input envelope for the kernel (Phase 2+).
 * Distinct from {@link import("./turn.js").UnderstoodBookingTurn} which is the
 * semantic patch produced by the turn interpreter (Phase 4).
 */
export type BookingInput =
  | { source: "patient_turn"; rawText: string }
  | { source: "semantic_patch"; patch: UnderstoodBookingTurn }
  | { source: "effect_result"; result: EffectResult }
  | { source: "control"; intent: "menu" | "abandon" | "handoff" };

import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  CONSULTATION_SERVICE_ID,
  MAIN_MENU_LABEL,
} from "../../shared/clinic-constants.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import {
  openServiceConfirmInteraction,
} from "../booking-session.js";
import { routeUnderstoodTurn } from "../receptionist-route.js";
import type { ILLMConnector } from "../types.js";
import {
  createClinicSupervisorNode,
  specialists,
  supervisorState,
} from "./supervisor-fixtures.js";

describe("interpret + routeUnderstoodTurn (ingress)", () => {
  it("routes contextual Так to booking while replacement is offered", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Так",
      awaitingServiceConfirm: false,
      offeredChoiceIds: ["cancel_existing", "decline"],
      offeredChoiceLabels: ["Скасувати", "Ні, дякую"],
    });
    // Replacement «Так» is offerAccept only when awaitingServiceConfirm;
    // cancel_existing is the labeled cancel chip — visit_cancel via label.
    const cancelPatch = interpretBookingTurnDeterministic({
      rawText: "Скасувати",
      offeredChoiceIds: ["cancel_existing", "decline"],
    });
    expect(cancelPatch.choice?.choiceId ?? cancelPatch.controlIntent?.kind).toBeTruthy();
    const draft = createEmptyBookingDraft();
    draft.replacement = {
      meeting: { id: "existing-1" },
      status: "offered",
    };
    const route = routeUnderstoodTurn(
      cancelPatch.choice != null
        ? { choice: cancelPatch.choice }
        : { controlIntent: { kind: "visit_cancel" } },
      draft,
    );
    expect(route.kind).toBe("booking");
    void patch;
  });

  it("«Так» on open service_confirm confirms pending service", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Так",
      awaitingServiceConfirm: true,
      offeredChoiceIds: ["offer_accept", "offer_choose_other"],
      offeredChoiceLabels: ["Так", "Обрати іншу процедуру"],
    });
    expect(patch).toEqual({
      serviceIntent: { kind: "confirm_pending_service" },
    });
    const draft = createEmptyBookingDraft();
    draft.serviceAcceptance = {
      status: "pending",
      service: { id: "svc-proc", name: "Колаген", source: "catalog" },
    };
    expect(routeUnderstoodTurn(patch, draft).kind).toBe("booking");
  });

  it("«Так» with stale catalog_browse still confirms (ingress overwrites)", async () => {
    const interpretTurn = vi.fn(async () =>
      interpretBookingTurnDeterministic({
        rawText: "Так",
        awaitingServiceConfirm: true,
        offeredChoiceIds: ["offer_accept", "offer_choose_other"],
        offeredChoiceLabels: ["Так", "Обрати іншу процедуру"],
      }),
    );
    const node = createClinicSupervisorNode({
      interpretTurn,
    });
    const draft = createEmptyBookingDraft();
    draft.serviceAcceptance = {
      status: "pending",
      service: {
        id: CONSULTATION_SERVICE_ID,
        name: "Консультація",
        source: "catalog",
      },
    };
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Так")],
        bookingDraft: draft,
        pendingInteraction: openServiceConfirmInteraction({
          id: CONSULTATION_SERVICE_ID,
          name: "Консультація",
          source: "catalog",
        }),
        // Stale ingress from a prior catalog turn — supervisor re-interprets.
        understoodTurn: { serviceIntent: { kind: "catalog_browse" } },
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          replyText: "offer",
        },
      }),
    );
    expect(update.next).toBe("booking");
    expect(update.understoodTurn).toEqual({
      serviceIntent: { kind: "confirm_pending_service" },
    });
  });

  it("main menu label finishes to greeting", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: MAIN_MENU_LABEL,
    });
    expect(patch).toEqual({ controlIntent: { kind: "main_menu" } });
    expect(routeUnderstoodTurn(patch, null).kind).toBe("main_menu");
  });

  it("Записатись routes to booking consultation", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Записатись",
    });
    expect(patch).toEqual({
      serviceIntent: { kind: "consultation" },
    });
    expect(routeUnderstoodTurn(patch, null).kind).toBe("booking");
  });

  it("Послуги idle routes to faq_capability", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Послуги",
    });
    expect(patch).toEqual({
      serviceIntent: { kind: "catalog_browse" },
    });
    expect(routeUnderstoodTurn(patch, null).kind).toBe("faq_capability");
  });

  it("empty patch with open session routes to booking re-ask", () => {
    const draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "a1",
    });
    const route = routeUnderstoodTurn({}, draft);
    expect(route.kind).toBe("booking");
  });

  it("visit_cancel with a planned visit goes to booking (kernel may clarify cancel vs move)", () => {
    const patch = {
      controlIntent: { kind: "visit_cancel" as const },
    };
    const draft = createEmptyBookingDraft();
    expect(routeUnderstoodTurn(patch, draft).kind).toBe("booking");
    expect(routeUnderstoodTurn(patch, null).kind).toBe("booking");
  });

  it("checkpoint after booking_started keeps deferred Friday/time/price facts", () => {
    let draft = reduceBookingDraft(null, {
      type: "booking_started",
      bookingAttemptId: "attempt-1",
    });
    draft = reduceBookingDraft(draft, {
      type: "deferred_turn_set",
      deferred: {
        bookingAttemptId: "attempt-1",
        boundEffectId: null,
        schedule: { date: "2026-10-24", preferredTime: "13:00" },
        informational: { question: "price", topic: "price" },
      },
    })!;
    expect(draft.deferredTurn).toMatchObject({
      schedule: { date: "2026-10-24", preferredTime: "13:00" },
      informational: { question: "price", topic: "price" },
    });
    expect(draft.bookingAttemptId).toBe("attempt-1");
  });
});

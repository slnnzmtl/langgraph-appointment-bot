import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { createEmptyBookingDraft } from "../booking-draft.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import { prepareFaqTurn } from "../agent-loop/prepare/faq.js";
import { tryFaqNoAiFinalize, applyFaqCatalogAiFinalize } from "../agent-loop/finalize/faq.js";
import { emptyFinalizeReply } from "../agent-loop/finalize/shared.js";
import { routeUnderstoodTurn } from "../receptionist-route.js";
import {
  faqCatalogPending,
  supervisorState,
} from "./supervisor-fixtures.js";

describe("FAQ catalog via interpret + routeUnderstoodTurn", () => {
  it("catalog_browse without session is faq_capability", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Послуги",
    });
    expect(routeUnderstoodTurn(patch, null).kind).toBe("faq_capability");
  });

  it("choose_other on service_confirm is decline_pending_service → booking", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Обрати іншу процедуру",
      awaitingServiceConfirm: true,
      offeredChoiceIds: ["offer_accept", "offer_choose_other"],
      offeredChoiceLabels: ["Так", "Обрати іншу процедуру"],
    });
    expect(patch).toEqual({
      serviceIntent: { kind: "decline_pending_service" },
    });
    const draft = createEmptyBookingDraft();
    draft.serviceAcceptance = {
      status: "pending",
      service: { id: "svc-1", name: "Ботікс", source: "catalog" },
    };
    expect(routeUnderstoodTurn(patch, draft).kind).toBe("booking");
  });

  it("address idleFaq routes to faq_capability", () => {
    const patch = interpretBookingTurnDeterministic({
      rawText: "Адреса",
    });
    expect(patch.idleFaq?.topic).toBe("address");
    expect(routeUnderstoodTurn(patch, null).kind).toBe("faq_capability");
  });
});

describe("FAQ prepare/finalize never assign bookingDraft", () => {
  it("prepare multi-id page only updates pendingInteraction", async () => {
    const state = supervisorState({
      messages: [new HumanMessage("Сім'я")],
      pendingInteraction: {
        kind: "service_candidate",
        owner: "faq",
        utterance: "catalog",
        choices: [
          {
            id: "family",
            label: "Сім'я",
            serviceIds: ["svc-a", "svc-b"],
          },
        ],
      },
      servicesContext: {
        list: [
          { id: "svc-a", name: "A", duration: 30 },
          { id: "svc-b", name: "B", duration: 30 },
          { id: "svc-c", name: "C", duration: 30 },
        ],
        fetchedAt: Date.now(),
      },
      bookingDraft: null,
    });
    const result = await prepareFaqTurn(state, {
      partitionCandidates: async () => [
        { label: "A / B", serviceIds: ["svc-a", "svc-b"] },
      ],
    });
    expect(result).not.toHaveProperty("kind");
    if (!("kind" in result)) {
      expect(Object.prototype.hasOwnProperty.call(result, "bookingDraft")).toBe(false);
      expect(result.pendingInteraction?.kind).toBe("service_candidate");
    }
  });

  it("prepare unique id stays FAQ highlight without bookingDraft", async () => {
    const catalog = faqCatalogPending(["Only"]);
    const state = supervisorState({
      messages: [new HumanMessage("Only")],
      pendingInteraction: {
        ...catalog,
        choices: [
          {
            id: "svc-only",
            label: "Only",
            serviceIds: ["svc-only"],
          },
        ],
      },
      servicesContext: {
        list: [{ id: "svc-only", name: "Only", duration: 30 }],
        fetchedAt: Date.now(),
      },
      bookingDraft: null,
    });
    const result = await prepareFaqTurn(state);
    expect(result).not.toHaveProperty("kind");
    expect(Object.prototype.hasOwnProperty.call(result, "bookingDraft")).toBe(false);
    expect(result.pendingInteraction?.kind).toBe("service_candidate");
    expect(result.pendingInteraction).toMatchObject({
      owner: "faq",
      choices: [{ id: "svc-only", serviceIds: ["svc-only"] }],
    });
    expect(result.understoodTurn).toBeUndefined();
    expect(result.next).toBeUndefined();
  });

  it("no-AI finalize does not set bookingDraft", () => {
    const catalog = faqCatalogPending(["A", "B"]);
    const reply = tryFaqNoAiFinalize(
      supervisorState({
        pendingInteraction: catalog,
        bookingDraft: null,
        servicesContext: {
          list: [
            { id: "svc-0", name: "A", duration: 30 },
            { id: "svc-1", name: "B", duration: 30 },
          ],
          fetchedAt: Date.now(),
        },
      }),
    );
    expect(reply).not.toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(reply?.patch ?? {}, "bookingDraft"),
    ).toBe(false);
    expect(reply?.yieldToSupervisor).toBe(false);
  });

  it("AI catalog finalize does not write bookingDraft on root open", async () => {
    const { reply, serviceOfferUpdate } = await applyFaqCatalogAiFinalize(
      supervisorState({
        pendingInteraction: null,
        bookingDraft: null,
        servicesContext: {
          list: [
            { id: "svc-a", name: "Ботокс лоб", duration: 30 },
            { id: "svc-b", name: "Ботокс очі", duration: 30 },
          ],
          fetchedAt: Date.now(),
        },
      }),
      emptyFinalizeReply("ok"),
      "open catalog\n<faq_catalog_action>open_catalog</faq_catalog_action>",
      {
        partitionCandidates: async () => [
          { label: "Ботокс", serviceIds: ["svc-a", "svc-b"] },
        ],
      },
    );
    expect(
      Object.prototype.hasOwnProperty.call(serviceOfferUpdate, "bookingDraft"),
    ).toBe(false);
    expect(reply.yieldToSupervisor).toBe(false);
  });
});

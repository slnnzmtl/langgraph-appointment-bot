import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { createEmptyBookingDraft } from "../booking/booking-draft.js";
import { interpretBookingTurnDeterministic } from "../booking-domain/interpret.js";
import { prepareFaqTurn } from "../agent-loop/prepare/faq.js";
import { tryFaqNoAiFinalize, applyFaqCatalogAiFinalize } from "../agent-loop/finalize/faq.js";
import { emptyFinalizeReply } from "../agent-loop/finalize/shared.js";
import { routeUnderstoodTurn } from "../receptionist-route.js";
import {
  createClinicSupervisorNode,
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

  it("prepare unique remaining from multi-choice opens FAQ highlight without bookingDraft", async () => {
    const state = supervisorState({
      messages: [new HumanMessage("Пілінг серединний")],
      pendingInteraction: {
        kind: "service_candidate",
        owner: "faq",
        utterance: "catalog",
        choices: [
          {
            id: "g-mid",
            label: "Пілінг серединний",
            serviceIds: ["svc-mid"],
          },
          {
            id: "g-surf",
            label: "Пілінг поверхневий",
            serviceIds: ["svc-surf"],
          },
        ],
      },
      servicesContext: {
        list: [
          { id: "svc-mid", name: "Пілінг серединний", duration: 45 },
          { id: "svc-surf", name: "Пілінг поверхневий", duration: 30 },
        ],
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
      choices: [{ id: "svc-mid", serviceIds: ["svc-mid"] }],
    });
    expect(result.faqSkipLlm).toBe(true);
    expect(result.understoodTurn).toBeUndefined();
    expect(result.next).toBeUndefined();
  });

  it("prepare re-tap of unique highlight is idempotent", async () => {
    const highlight = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "catalog",
      choices: [
        {
          id: "svc-mid",
          label: "Пілінг серединний",
          serviceIds: ["svc-mid"],
        },
      ],
    };
    const result = await prepareFaqTurn(
      supervisorState({
        messages: [new HumanMessage("Пілінг серединний")],
        pendingInteraction: highlight,
        servicesContext: {
          list: [{ id: "svc-mid", name: "Пілінг серединний", duration: 45 }],
          fetchedAt: Date.now(),
        },
        bookingDraft: null,
      }),
    );
    expect(result.pendingInteraction).toBe(highlight);
    expect(result.faqSkipLlm).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "bookingDraft")).toBe(false);
  });

  it("no-AI finalize unique highlight is informational with Записатись", () => {
    const reply = tryFaqNoAiFinalize(
      supervisorState({
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          choices: [
            {
              id: "svc-mid",
              label: "Пілінг серединний",
              serviceIds: ["svc-mid"],
            },
          ],
        },
        bookingDraft: null,
        servicesContext: {
          list: [
            {
              id: "svc-mid",
              name: "Пілінг серединний",
              duration: 45,
              description: "Середня глибина",
            },
          ],
          fetchedAt: Date.now(),
        },
      }),
    );
    expect(reply).not.toBeNull();
    expect(reply?.replyText).toContain("Пілінг серединний");
    expect(reply?.replyText).toContain("Середня глибина");
    expect(reply?.replyText).toMatch(/Записатись/);
    expect(reply?.replyText).not.toMatch(/Який варіант вам підходить/);
    expect(reply?.replyButtons).toEqual(["Записатись", "Послуги"]);
    expect(
      Object.prototype.hasOwnProperty.call(reply?.patch ?? {}, "bookingDraft"),
    ).toBe(false);
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
    expect(reply?.replyText).toMatch(/Який варіант вам підходить/);
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

  it("AI unique open_catalog renders informational highlight not a picker", async () => {
    const { reply, serviceOfferUpdate } = await applyFaqCatalogAiFinalize(
      supervisorState({
        pendingInteraction: null,
        bookingDraft: null,
        servicesContext: {
          list: [
            { id: "svc-mid", name: "Пілінг серединний", duration: 45 },
          ],
          fetchedAt: Date.now(),
        },
      }),
      emptyFinalizeReply("ok"),
      [
        "Ось про пілінг",
        '<faq_catalog_action action="open_catalog" query="Пілінг серединний"/>',
      ].join("\n"),
    );
    expect(
      Object.prototype.hasOwnProperty.call(serviceOfferUpdate, "bookingDraft"),
    ).toBe(false);
    expect(serviceOfferUpdate.pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
      choices: [{ id: "svc-mid", serviceIds: ["svc-mid"] }],
    });
    expect(reply.replyText).toContain("Пілінг серединний");
    expect(reply.replyText).not.toMatch(/Який варіант вам підходить/);
    expect(reply.replyButtons).toEqual(["Записатись", "Послуги"]);
  });
});

describe("FAQ highlight book_highlighted promotion", () => {
  const highlightInteraction = {
    kind: "service_candidate" as const,
    owner: "faq" as const,
    utterance: "botox",
    choices: [
      {
        id: "svc-botox",
        label: "Botox",
        serviceIds: ["svc-botox"],
      },
    ],
  };

  it("promotes book_highlighted to catalog_service when the CRM row is current", async () => {
    const node = createClinicSupervisorNode({
      interpretTurn: async () => ({ serviceIntent: { kind: "book_highlighted" } }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("book this one")],
        pendingInteraction: highlightInteraction,
        servicesContext: {
          list: [{ id: "svc-botox", name: "Botox CRM", duration: 30 }],
          fetchedAt: Date.now(),
        },
        bookingDraft: null,
      }),
    );
    expect(update.next).toBe("booking");
    expect(update.understoodTurn).toEqual({
      serviceIntent: {
        kind: "catalog_service",
        serviceId: "svc-botox",
        serviceName: "Botox CRM",
      },
    });
  });

  it("clears stale highlight and replies when the CRM row is missing", async () => {
    const node = createClinicSupervisorNode({
      interpretTurn: async () => ({ serviceIntent: { kind: "book_highlighted" } }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("book this one")],
        pendingInteraction: highlightInteraction,
        servicesContext: {
          list: [{ id: "svc-other", name: "Other", duration: 30 }],
          fetchedAt: Date.now(),
        },
        bookingDraft: null,
      }),
    );
    expect(update.next).toBe("FINISH");
    expect(update.pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toMatch(/каталозі|catalog/i);
    expect(update.understoodTurn).toBeNull();
  });

  it("refetches catalog and promotes book_highlighted when servicesContext was absent", async () => {
    const node = createClinicSupervisorNode({
      interpretTurn: async () => ({ serviceIntent: { kind: "book_highlighted" } }),
      loadServices: async () => ({
        list: [{ id: "svc-botox", name: "Botox CRM", duration: 30 }],
        fetchedAt: Date.now(),
      }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Записатись")],
        pendingInteraction: highlightInteraction,
        servicesContext: null,
        bookingDraft: null,
      }),
    );
    expect(update.next).toBe("booking");
    expect(update.understoodTurn).toEqual({
      serviceIntent: {
        kind: "catalog_service",
        serviceId: "svc-botox",
        serviceName: "Botox CRM",
      },
    });
    expect(update.servicesContext?.list).toHaveLength(1);
  });

  it("does not claim catalog removal when servicesContext is absent and refetch fails", async () => {
    const node = createClinicSupervisorNode({
      interpretTurn: async () => ({ serviceIntent: { kind: "book_highlighted" } }),
      loadServices: async () => null,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Записатись")],
        pendingInteraction: highlightInteraction,
        servicesContext: null,
        bookingDraft: null,
      }),
    );
    expect(update.next).toBe("FINISH");
    expect(update.pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toMatch(/перевірити|verify/i);
    expect(update.lastHandoff?.replyText).not.toMatch(/більше не|no longer/i);
  });

  it("routes consultation to booking without promoting Botox on FAQ highlight", async () => {
    const node = createClinicSupervisorNode({
      interpretTurn: async () => ({ serviceIntent: { kind: "consultation" } }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Хочу консультацію")],
        pendingInteraction: highlightInteraction,
        servicesContext: {
          list: [{ id: "svc-botox", name: "Botox CRM", duration: 30 }],
          fetchedAt: Date.now(),
        },
        bookingDraft: null,
      }),
    );
    expect(update.next).toBe("booking");
    expect(update.understoodTurn).toEqual({
      serviceIntent: { kind: "consultation" },
    });
  });

  it("does not start Botox booking when patient says yes without service confirm", async () => {
    const node = createClinicSupervisorNode();
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Так")],
        pendingInteraction: highlightInteraction,
        servicesContext: {
          list: [{ id: "svc-botox", name: "Botox CRM", duration: 30 }],
          fetchedAt: Date.now(),
        },
        bookingDraft: null,
      }),
    );
    expect(update.next).not.toBe("booking");
    expect(update.understoodTurn?.serviceIntent?.kind).not.toBe("catalog_service");
  });
});

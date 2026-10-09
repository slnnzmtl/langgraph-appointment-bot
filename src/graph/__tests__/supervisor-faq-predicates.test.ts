import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ABANDON_BOOKING_REPLY_UK,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  INTENT_SKIP_LABEL,
  MAIN_MENU_LABEL,
  RETURN_TO_BOOKING_LABEL_UK,
  VISIT_CHANGE_MENU,
  VISIT_DECLINE_REPLY_UK,
} from "../../shared/clinic-constants.js";
import { createEmptyBookingDraft } from "../booking-draft.js";
import {
  openVisitNoteInteraction,
  visitMeetingChoiceLabel,
} from "../booking-session.js";
import { createAgentCommandPrepareNode } from "../agent-loop.js";
import type { ILLMConnector } from "../types.js";
import {
  agents,
  createClinicSupervisorNode,
  faqCatalogPending,
  serviceConfirmPending,
  shouldRouteProcedureBrowseToFaq,
  shouldStayInFaqCatalog,
  stickyContinueAgentId,
  supervisorState,
} from "./supervisor-fixtures.js";

describe("shouldRouteProcedureBrowseToFaq", () => {
  it.each(["20 октября", "20.10", "2026-10-20"])(
    "is false for a supported date format after a consultation offer (%s)", (date) => {
      expect(
        shouldRouteProcedureBrowseToFaq(
          supervisorState({
            pendingInteraction: serviceConfirmPending,
            lastHandoff: {
              agentId: "booking",
              agentName: "Booking",
              status: "ok",
              replyText: "Підібрати вільний час на консультацію?",
              replyButtons: ["Так", "Обрати іншу процедуру"],
            },
            messages: [
              new AIMessage("Підібрати вільний час на консультацію?"),
              new HumanMessage(date),
            ],
          }),
        ),
      ).toBe(false);
    },
  );

  it("defers free-text procedure names after a consultation offer to the model", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("запиши на ботулінотерапію"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false after Так to a consultation offer", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("Так"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false after a book-this-procedure offer when they name a day", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: {
            ...serviceConfirmPending,
            service: { id: "svc-botox", name: "Botox", source: "catalog" },
          },
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Бажаєте записатися на цю процедуру?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Бажаєте записатися на цю процедуру?"),
            new HumanMessage("2 жовтня"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("defers free-text family names after a FAQ book-this-procedure offer to the model", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: {
            ...serviceConfirmPending,
            service: { id: "svc-botox", name: "Botox", source: "catalog" },
          },
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            yieldToSupervisor: true,
            replyText: "Бажаєте записатися на цю процедуру?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Чудово, обрано: Ботулінотерапія Botox, Disport 1 зона.\n\nБажаєте записатися на цю процедуру?"),
            new HumanMessage("на ліполітики запиши"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for visit-change paraphrases after a consultation offer", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("перенеси будь ласка"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for a phone number after a consultation offer", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("+380501112233"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for English tomorrow after a consultation offer", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("tomorrow"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("defers multi-line free text after a consultation offer to the model", () => {
    expect(
      shouldRouteProcedureBrowseToFaq(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyText: "Підібрати вільний час на консультацію?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("запиши на ботулінотерапію\nдякую"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it.each(["Обрати іншу процедуру", "Choose another procedure"] as const)(
    "is true for choose_other chip %s despite SUPERVISOR_OWNED",
    (label) => {
      expect(
        shouldRouteProcedureBrowseToFaq(
          supervisorState({
            pendingInteraction: {
              ...serviceConfirmPending,
              service: { id: "svc-peel", name: "Пілінг поверхневий", source: "catalog" },
              choices: [
                { id: "accept", label: label === "Choose another procedure" ? "Yes" : "Так" },
                { id: "choose_other", label },
              ],
            },
            lastHandoff: {
              agentId: "faq",
              agentName: "FAQ",
              status: "ok",
              yieldToSupervisor: true,
              replyText: "Бажаєте записатися на цю процедуру?",
              replyButtons: [
                label === "Choose another procedure" ? "Yes" : "Так",
                label,
              ],
            },
            messages: [
              new AIMessage("Бажаєте записатися на цю процедуру?"),
              new HumanMessage(label),
            ],
          }),
        ),
      ).toBe(true);
    },
  );

  it("skips the LLM and routes to faq after Обрати іншу процедуру on service_confirm", async () => {
    const invoke = vi.fn();
    const supervisorLlm = {
      bindRoutingTools: vi.fn(() => ({ invoke })),
    } as unknown as ILLMConnector;
    invoke.mockResolvedValue({ next: "booking", reply: "should not be used" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        pendingInteraction: {
          ...serviceConfirmPending,
          service: { id: "svc-peel", name: "Пілінг поверхневий", source: "catalog" },
        },
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          yieldToSupervisor: true,
          replyText: "Бажаєте записатися на цю процедуру?",
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage("Бажаєте записатися на цю процедуру?"),
          new HumanMessage("Обрати іншу процедуру"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(update).toMatchObject({
      next: "faq",
      lastHandoff: null,
      availabilityContext: null,
      bookingDraft: null,
      pendingInteraction: null,
    });
  });

  it("routes clarifying free text via model intent=faq while keeping service_confirm", async () => {
    const invoke = vi.fn();
    const supervisorLlm = {
      bindRoutingTools: vi.fn(() => ({ invoke })),
    } as unknown as ILLMConnector;
    invoke.mockResolvedValue({ next: "FINISH", intent: "faq", reply: "Орієнтовна ціна…" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });
    const procedureOffer = {
      ...serviceConfirmPending,
      service: {
        id: "svc-hyper",
        name: "Лікування гіпергідрозу",
        source: "catalog" as const,
      },
    };

    const update = await node(
      supervisorState({
        pendingInteraction: procedureOffer,
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          yieldToSupervisor: true,
          replyText: "Бажаєте записатися на цю процедуру?",
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage(
            "Чудово, обрано: Лікування гіпергідрозу.\n\nБажаєте записатися на цю процедуру?",
          ),
          new HumanMessage("Скільки коштує"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("faq");
  });

  it("routes free-text catalog browse via model intent=faq", async () => {
    const invoke = vi.fn();
    const supervisorLlm = {
      bindRoutingTools: vi.fn(() => ({ invoke })),
    } as unknown as ILLMConnector;
    invoke.mockResolvedValue({ next: "booking", intent: "faq" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        pendingInteraction: serviceConfirmPending,
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Підібрати вільний час на консультацію?",
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("запиши на ботулінотерапію"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update).toMatchObject({ next: "faq", lastHandoff: null });
  });
});

describe("shouldStayInFaqCatalog", () => {
  const openFaqCatalogState = () =>
    supervisorState({
      pendingInteraction: {
        kind: "service_candidate",
        owner: "faq",
        utterance: "ботулінотерапія",
        choices: [
          { id: "svc-d", label: "Disport", serviceIds: ["svc-d"] },
          { id: "svc-n", label: "Nabota", serviceIds: ["svc-n"] },
          { id: "svc-b", label: "Botox", serviceIds: ["svc-b"] },
        ],
      },
      lastHandoff: {
        agentId: "faq",
        agentName: "FAQ",
        status: "ok",
        replyText: "Який препарат вас цікавить?",
        replyButtons: ["Disport", "Nabota", "Botox"],
      },
      messages: [
        new AIMessage("Який препарат вас цікавить?"),
        new HumanMessage("запиши на ботокс"),
      ],
    });

  it("keeps free text in FAQ while FAQ-owned catalog interaction is open", () => {
    expect(shouldStayInFaqCatalog(openFaqCatalogState())).toBe(true);
  });

  it("stickyContinueAgentId returns faq before the session-close FAQ route", () => {
    expect(stickyContinueAgentId(openFaqCatalogState())).toBe("faq");
  });

  it("is false when FAQ yielded a book-this-procedure offer", () => {
    expect(
      shouldStayInFaqCatalog(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            yieldToSupervisor: true,
            replyText: "Бажаєте записатися на цю процедуру?",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Бажаєте записатися на цю процедуру?"),
            new HumanMessage("на ліполітики запиши"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("supervisor sticky-routes catalog free text without clearing pendingInteraction", async () => {
    const invoke = vi.fn();
    const supervisorLlm = {
      bindRoutingTools: vi.fn(() => ({ invoke })),
    } as unknown as ILLMConnector;
    invoke.mockResolvedValue({ next: "booking", reply: "should not be used" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });
    const catalogPending = openFaqCatalogState().pendingInteraction;

    const update = await node(openFaqCatalogState());

    expect(invoke).not.toHaveBeenCalled();
    expect(update.next).toBe("faq");
    expect(update.lastHandoff).toBeNull();
    // Sticky path omits pendingInteraction — session-close must not null it.
    expect(update.pendingInteraction).toBeUndefined();
    expect(catalogPending?.kind).toBe("service_candidate");
  });
});


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
  createCachedGeminiModel,
  createClinicSupervisorNode,
  dateSelectPending,
  faqCatalogPending,
  isCachedContentNotFoundError,
  serviceConfirmPending,
  shouldContinueInBooking,
  shouldContinueInFaq,
  stickyContinueAgentId,
  supervisorState,
} from "./supervisor-fixtures.js";

describe("cancel-and-rebook routing", () => {
  it("routes contextual Так to booking while replacement is offered", () => {
    const draft = createEmptyBookingDraft();
    draft.replacement = {
      meeting: { id: "existing-1" },
      status: "offered",
    };
    const state = supervisorState({
      messages: [new HumanMessage("Так")],
      bookingDraft: draft,
    });

    expect(stickyContinueAgentId(state)).toBe("booking");
  });
});

describe("stickyContinueAgentId open note reply", () => {
  const awaitingNoteDraft = () => {
    const draft = createEmptyBookingDraft();
    draft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-consult", name: "Консультація", source: "catalog" },
    };
    draft.selectedDate = "2026-10-19";
    draft.selectedSlot = {
      dateStart: "2026-10-19T11:30:00",
      dateEnd: "2026-10-19T12:00:00",
      label: "11:30",
    };
    draft.note = { status: "awaiting" };
    draft.phase = "note";
    return draft;
  };

  it("keeps free text in booking while visit_note is open", () => {
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage("запиши на ботокс")],
      pendingInteraction: openVisitNoteInteraction(),
      bookingDraft: awaitingNoteDraft(),
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "note?",
        replyButtons: [INTENT_SKIP_LABEL],
      },
    }))).toBe("booking");
  });

  it("keeps free text in booking when note is awaiting without pendingInteraction", () => {
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage("запиши на ботокс")],
      pendingInteraction: null,
      bookingDraft: awaitingNoteDraft(),
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "note?",
        replyButtons: [INTENT_SKIP_LABEL],
      },
    }))).toBe("booking");
  });

  it("keeps free text in booking when note is unasked and slot is selected", () => {
    const draft = awaitingNoteDraft();
    draft.note = { status: "unasked" };
    draft.phase = "note";
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage("запиши на ботокс")],
      pendingInteraction: null,
      bookingDraft: draft,
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "slot?",
        replyButtons: [],
      },
    }))).toBe("booking");
  });

  it("keeps free text in booking during date phase before a slot", () => {
    const draft = createEmptyBookingDraft();
    draft.serviceAcceptance = {
      status: "accepted",
      service: { id: "svc-consult", name: "Консультація", source: "catalog" },
    };
    draft.phase = "date";
    draft.selectedDate = "2026-10-19";
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage("на завтра")],
      pendingInteraction: null,
      bookingDraft: draft,
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "when?",
        replyButtons: [],
      },
    }))).toBe("booking");
  });

  it("does not sticky-continue supervisor-owned labels during an open note", () => {
    const base = {
      pendingInteraction: openVisitNoteInteraction(),
      bookingDraft: awaitingNoteDraft(),
      lastHandoff: {
        agentId: "booking" as const,
        agentName: "Booking",
        status: "ok" as const,
        replyText: "note?",
        replyButtons: [INTENT_SKIP_LABEL],
      },
    };
    expect(stickyContinueAgentId(supervisorState({
      ...base,
      messages: [new HumanMessage(MAIN_MENU_LABEL)],
    }))).toBeNull();
    expect(stickyContinueAgentId(supervisorState({
      ...base,
      messages: [new HumanMessage("Обрати іншу процедуру")],
    }))).toBeNull();
  });

  it("keeps FAQ catalog chip taps in FAQ while a booking interaction is preserved", () => {
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage("Ботулінотерапія")],
      pendingInteraction: {
        kind: "service_candidate",
        owner: "faq",
        utterance: "процедури",
        choices: [
          { id: "svc-b", label: "Ботулінотерапія", serviceIds: ["svc-b"] },
          { id: "svc-c", label: "Консультація", serviceIds: ["svc-c"] },
        ],
      },
      bookingDraft: awaitingNoteDraft(),
      lastHandoff: {
        agentId: "faq",
        agentName: "FAQ",
        status: "ok",
        replyText: "Оберіть послугу зі списку",
        replyButtons: ["Ботулінотерапія", "Консультація"],
      },
    }))).toBe("faq");
  });

  it("routes explicit return_to_booking to Booking over FAQ catalog", () => {
    expect(stickyContinueAgentId(supervisorState({
      messages: [new HumanMessage(RETURN_TO_BOOKING_LABEL_UK)],
      pendingInteraction: {
        kind: "visit_note",
        choices: [
          { id: "skip", label: INTENT_SKIP_LABEL },
          { id: "return_to_booking", label: RETURN_TO_BOOKING_LABEL_UK },
        ],
      },
      bookingDraft: awaitingNoteDraft(),
      lastHandoff: {
        agentId: "faq",
        agentName: "FAQ",
        status: "ok",
        replyText: "Оберіть послугу зі списку",
        replyButtons: ["Ботулінотерапія", RETURN_TO_BOOKING_LABEL_UK],
      },
    }))).toBe("booking");
  });
});

describe("shouldContinueInBooking", () => {
  it("is true when last handoff is booking/ok and the human taps an offered label", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          pendingInteraction: dateSelectPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["25 серпня", "3 вересня", "Інша дата"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("25 серпня"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is true when reply buttons were stripped from checkpointed history", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          pendingInteraction: serviceConfirmPending,
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("Так"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is false for supervisor-owned labels even when they appear on lastHandoff", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Підібрати вільний час на консультацію?"),
            new HumanMessage("Обрати іншу процедуру"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["Мій запис", "Послуги", "Адреса"],
          },
          messages: [
            new AIMessage("Чим можу допомогти?"),
            new HumanMessage("Послуги"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for free text and for non-booking handoffs", () => {
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["25 серпня"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("а скільки коштує?"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInBooking(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["25 серпня"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage("25 серпня"),
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldContinueInFaq", () => {
  it("is true when last handoff is faq/ok and the human taps an offered catalog label", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          pendingInteraction: faqCatalogPending([
            "Ін'єкційні процедури",
            "Консультації та діагностика",
          ]),
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["Ін'єкційні процедури", "Консультації та діагностика"],
          },
          messages: [
            new AIMessage("Який напрямок вас цікавить?"),
            new HumanMessage("Ін'єкційні процедури"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is true when reply buttons were stripped from checkpointed history", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          pendingInteraction: faqCatalogPending(["ботулінотерапія", "збільшення губ"]),
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["ботулінотерапія", "збільшення губ"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("ботулінотерапія"),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("is false when lastHandoff yielded to supervisor", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            yieldToSupervisor: true,
            replyButtons: ["Так", "Обрати іншу процедуру"],
          },
          messages: [
            new AIMessage("Записати вас на консультацію?"),
            new HumanMessage("Так"),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("is false for supervisor-owned labels, free text, and non-faq handoffs", () => {
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["Записатись", "Послуги", "Адреса"],
          },
          messages: [
            new AIMessage("Чим можу допомогти?"),
            new HumanMessage("Послуги"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "faq",
            agentName: "FAQ",
            status: "ok",
            replyButtons: ["ботулінотерапія"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("а скільки коштує?"),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldContinueInFaq(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["ботулінотерапія"],
          },
          messages: [
            new AIMessage("Яка процедура вас цікавить?"),
            new HumanMessage("ботулінотерапія"),
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("createClinicSupervisorNode sticky faq continue", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "booking", reply: "should not be used" });
  });

  it("skips the LLM and routes to faq when a catalog shortcut is tapped", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        pendingInteraction: faqCatalogPending(["Ін'єкційні процедури"]),
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          replyButtons: ["Ін'єкційні процедури"],
        },
        messages: [
          new AIMessage("Який напрямок вас цікавить?"),
          new HumanMessage("Ін'єкційні процедури"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(update).toMatchObject({ next: "faq", lastHandoff: null });
  });

  it("still calls the LLM after a yielded FAQ consultation offer", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          yieldToSupervisor: true,
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage("Записати вас на консультацію?"),
          new HumanMessage("Так"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
  });

  it("does not seed a cancel of the listed visit when Так accepts a consultation offer", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        bookingContext: {
          meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-08-21 11:00:00" }],
          dateFrom: "2026-08-11",
        },
        contactContext: { contacts: [] },
        prefetchFetchedAt: Date.now(),
        pendingInteraction: serviceConfirmPending,
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["Так", "Обрати іншу процедуру"],
        },
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("Так"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(update.next).toBe("booking");
    expect(update.bookingDraft?.pendingCommand ?? null).toBeNull();
  });
});

describe("createClinicSupervisorNode sticky booking continue", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "faq", reply: "should not be used" });
  });

  it("skips the LLM and routes to booking when a booking shortcut is tapped", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      bookingContext: { meetings: [], dateFrom: "2026-08-11" },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        pendingInteraction: dateSelectPending,
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["25 серпня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage("25 серпня"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledOnce();
    expect(update).toMatchObject({
      next: "booking",
      lastHandoff: null,
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      prefetchDirty: false,
    });
    expect(update.prefetchFetchedAt).toEqual(expect.any(Number));
  });

  it("still calls the LLM for free text after a booking turn", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["25 серпня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage("а скільки коштує консультація?"),
        ],
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("faq");
  });
});

describe("createClinicSupervisorNode availability session reset", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;
  const listedContact = {
    contacts: [{ id: "c-1", firstName: "Марія", missingFields: [] as string[] }],
  };
  const listedMeetings = {
    meetings: [] as Array<{ id: string; name: string; dateStart: string; dateEnd: string }>,
    dateFrom: "2026-09-11",
  };
  const pagedSnapshot = {
    days: [
      {
        date: "2026-10-05",
        dayLabel: "5 жовтня (понеділок)",
        slots: [
          {
            id: "a",
            label: "11:00",
            dateStart: "2026-10-05T11:00:00",
            dateEnd: "2026-10-05T11:30:00",
          },
        ],
      },
    ],
    stepMinutes: 30,
  };

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
  });

  it.each(["Записатись", "Послуги", "Обрати іншу процедуру"] as const)(
    "nulls availabilityContext on owned label %s (prefetch reuse)",
    async (label) => {
      invoke.mockResolvedValue({ next: label === "Записатись" ? "booking" : "faq", reply: "ok" });
      const prefetch = vi.fn(async () => ({
        contactContext: listedContact,
        bookingContext: listedMeetings,
      }));
      const node = createClinicSupervisorNode({
        agents,
        supervisorLlm,
        loadSupervisorPrompt: () => "STATIC",
        prefetch,
      });

      const update = await node(
        supervisorState({
          lastHandoff: {
            agentId: "booking",
            agentName: "Booking",
            status: "ok",
            replyButtons: ["28 вересня", "Інша дата"],
          },
          messages: [
            new AIMessage("Який день вам зручний?"),
            new HumanMessage(label),
          ],
          contactContext: listedContact,
          bookingContext: listedMeetings,
          availabilityContext: pagedSnapshot,
          prefetchFetchedAt: Date.now(),
        }),
      );

      expect(prefetch).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledOnce();
      expect(update.availabilityContext).toBeNull();
    },
  );

  it("nulls availabilityContext when FAQ routes to booking", async () => {
    invoke.mockResolvedValue({ next: "booking", reply: "" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "faq",
          agentName: "FAQ",
          status: "ok",
          yieldToSupervisor: true,
          replyButtons: ["Консультація"],
        },
        messages: [
          new AIMessage("Яка процедура?"),
          new HumanMessage("хочу записатися на консультацію"),
        ],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        availabilityContext: pagedSnapshot,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
    expect(update.availabilityContext).toBeNull();
  });

  it.each(["Інша дата", "другая дата", "другая", "другой"])(
    "keeps availabilityContext on sticky alternative-date reply %s (prefetch reuse)",
    async (otherDateReply) => {
    const prefetch = vi.fn(async () => ({
      contactContext: listedContact,
      bookingContext: listedMeetings,
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["28 вересня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage(otherDateReply),
        ],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        availabilityContext: pagedSnapshot,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(prefetch).not.toHaveBeenCalled();
    expect(update.next).toBe("booking");
    expect(update.availabilityContext).toBeUndefined();
    },
  );

  it("keeps availabilityContext on in-booking free text routed to booking", async () => {
    invoke.mockResolvedValue({ next: "booking", reply: "" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
    });

    const update = await node(
      supervisorState({
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyButtons: ["28 вересня", "Інша дата"],
        },
        messages: [
          new AIMessage("Який день вам зручний?"),
          new HumanMessage("а можна після обіду?"),
        ],
        contactContext: listedContact,
        bookingContext: listedMeetings,
        availabilityContext: pagedSnapshot,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
    expect(update.availabilityContext).toBeUndefined();
  });
});

describe("stickyContinueAgentId visit-change after FINISH", () => {
  it("routes Скасувати and Перенести to booking without needing stored buttons", () => {
    const meetings = {
      meetings: [{ id: "m-1", name: "Consult", dateStart: "2026-08-21 11:00:00" }],
      dateFrom: "2026-08-11",
    };
    expect(
      stickyContinueAgentId(
        supervisorState({
          bookingContext: meetings,
          lastHandoff: {
            agentId: "FINISH",
            agentName: "supervisor",
            status: "ok",
            replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
          },
          messages: [
            new AIMessage("Бажаєте перенести або скасувати цей візит?"),
            new HumanMessage("Скасувати"),
          ],
        }),
      ),
    ).toBe("booking");
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: null,
          messages: [
            new AIMessage("Заплановані візити: консультація — 21 серпня о 11:00 🗓️"),
            new HumanMessage("Перенести"),
          ],
        }),
      ),
    ).toBe("booking");
    // Bare Cancel with no planned visits is abandon, not sticky booking.
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: null,
          messages: [new HumanMessage("Cancel")],
        }),
      ),
    ).toBeNull();
  });

  it("does not sticky-route Ні, дякую (supervisor-owned)", () => {
    expect(
      stickyContinueAgentId(
        supervisorState({
          lastHandoff: {
            agentId: "FINISH",
            agentName: "supervisor",
            status: "ok",
            replyButtons: ["Перенести", "Скасувати", "Ні, дякую"],
          },
          messages: [new HumanMessage("Ні, дякую")],
        }),
      ),
    ).toBeNull();
  });
});


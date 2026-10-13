import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  CONSULTATION_SERVICE_ID,
  SERVICE_CONFIRM_CONSULTATION_EN,
} from "../../shared/clinic-constants.js";
import {
  createAgentFinalizeNode,
  createAgentPrepareNode,
  routeAfterAgentPrepare,
} from "../agent-loop.js";
import type { ClinicState } from "../state.js";
import type { ClinicAgentDefinition, ILLMConnector } from "../types.js";
import {
  agents,
  createClinicSupervisorNode,
  supervisorState,
} from "./supervisor-fixtures.js";

const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  supervisorIntent: null,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  availabilityCursor: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
  bookingNoteStatus: "unasked",
  selectedSlot: null,
  selectedAvailabilityDate: null,
  bookingDraft: null,
  pendingInteraction: null,
  noteOrchQueued: false,
  serviceChangeNotice: null,
  bookingSchemaVersion: 1,
  pendingCancellationPurpose: null,
  ...overrides,
});

const botoxServices = {
  list: [
    { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
    { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
    { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
    { id: "n2", name: "Ботулінотерапія Nabota 2 зони" },
    { id: "c1", name: "Корекція ботокс" },
    { id: "m1", name: "Мезоботокс" },
  ],
};

const familySelector = async () => ({
  serviceIds: ["z1", "z2", "n1", "n2"],
  groups: [
    { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
    { label: "Nabota", serviceIds: ["n1", "n2"] },
  ],
});

const listedMeetings = {
  meetings: [{
    id: "m-1",
    name: "Консультація",
    dateStart: "2026-08-21 11:00:00",
    dateEnd: "2026-08-21 11:30:00",
  }],
  dateFrom: "2026-08-11",
};

const ownedContact = {
  contacts: [{
    id: "c-1",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    missingFields: [] as string[],
  }],
  ownership: "telegram" as const,
};

describe("booking prepare entry (state)", () => {
  const bookingAgent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("opens REPLACE with null serviceAcceptance for an existing visit and a named booking", async () => {
    const prepare = createAgentPrepareNode("booking", {
      selectCandidates: familySelector,
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("запиши на ботокс")],
        bookingContext: listedMeetings,
        servicesContext: botoxServices,
        contactContext: ownedContact,
      }),
    );
    expect(update.bookingDraft?.replacement?.status).toBe("offered");
    expect(update.bookingDraft?.serviceAcceptance ?? null).toBeNull();
    expect(update.pendingInteraction?.kind ?? null).not.toBe("service_candidate");

    const rendered = await createAgentFinalizeNode(bookingAgent)(
      clinicState({
        messages: [new HumanMessage("запиши на ботокс")],
        bookingContext: listedMeetings,
        bookingDraft: update.bookingDraft,
        agentMessages: [new HumanMessage("запиши на ботокс")],
      }),
    );
    expect(rendered.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "replacement",
    });
    expect(rendered.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
  });

  it("opens a consultation offer for «Записатись» and skips the booking LLM", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({ messages: [new HumanMessage("Записатись")] }),
    );
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    const merged = clinicState({
      messages: [new HumanMessage("Записатись")],
      bookingDraft: update.bookingDraft,
      pendingInteraction: update.pendingInteraction,
    });
    expect(
      routeAfterAgentPrepare(
        merged,
        "booking__llm",
        "booking__command_prepare",
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
  });

  it("opens consultation for idle booking when contact is owned and there is no visit", async () => {
    const prepare = createAgentPrepareNode("booking");
    const text = "Доброго дня. Можливо записатися на прийом?";
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage(text)],
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    );
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.bookingDraft?.serviceAcceptance?.service.id).toBe(
      CONSULTATION_SERVICE_ID,
    );
  });

  it("does not open consultation or catalog for unknown contact idle booking", async () => {
    let loadCalls = 0;
    const prepare = createAgentPrepareNode("booking", {
      loadServices: async () => {
        loadCalls += 1;
        return botoxServices;
      },
      selectCandidates: familySelector,
    });
    const text = "I want to book an appointment. Start by looking up my contact.";
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage(text)],
        contactContext: { contacts: [] },
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
        servicesContext: null,
      }),
    );
    expect(loadCalls).toBe(0);
    expect(update.pendingInteraction?.kind ?? null).not.toBe("service_confirm");
    expect(update.pendingInteraction?.kind ?? null).not.toBe("service_candidate");
    expect(update.bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("opens an English consultation offer for English «Book» keyboard", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({ messages: [new HumanMessage("Book")] }),
    );
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    if (update.pendingInteraction?.kind === "service_confirm") {
      expect(update.pendingInteraction.choices.map((choice) => choice.label)).toEqual([
        ...BOOKING_OFFER_MENU_EN,
      ]);
    }
    const rendered = await createAgentFinalizeNode(bookingAgent)(
      clinicState({
        messages: [new HumanMessage("Book")],
        bookingDraft: update.bookingDraft,
        pendingInteraction: update.pendingInteraction,
        agentMessages: [],
      }),
    );
    expect(rendered.lastHandoff?.replyText).toBe(SERVICE_CONFIRM_CONSULTATION_EN);
  });

  it("does not open a named catalog from idle booking prepare", async () => {
    const update = await createAgentPrepareNode("booking", {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: botoxServices,
      contactContext: ownedContact,
      bookingContext: { meetings: [], dateFrom: "2026-10-11" },
    }));
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.bookingDraft?.serviceAcceptance?.service.id).toBe(
      CONSULTATION_SERVICE_ID,
    );
  });
});

describe("FAQ idle named_procedure catalog entry", () => {
  it("opens family chips from idle FAQ prepare on named_procedure + ботокс", async () => {
    const faq = await createAgentPrepareNode("faq", {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: botoxServices,
      supervisorIntent: "named_procedure",
    }));
    expect(faq.pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
    });
    expect(
      faq.pendingInteraction?.kind === "service_candidate"
        ? faq.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["Botox, Disport", "Nabota"]);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на ботокс")],
          servicesContext: botoxServices,
          supervisorIntent: "named_procedure",
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
      ),
    ).toBe("faq__finalize");
  });

  it("opens service_confirm for a unique collagen row on named_procedure", async () => {
    const faq = await createAgentPrepareNode("faq")(clinicState({
      messages: [new HumanMessage("запиши на колаген")],
      servicesContext: {
        list: [
          {
            id: "svc-collagen",
            name: "Колагеностимуляція Полімолочна кислота",
            duration: 60,
          },
          { id: "svc-botox", name: "Ботулінотерапія Botox 1 зона" },
        ],
      },
      supervisorIntent: "named_procedure",
    }));
    expect(faq.pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: {
        id: "svc-collagen",
        name: "Колагеностимуляція Полімолочна кислота",
      },
    });
    expect(faq.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: "svc-collagen" },
    });
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на колаген")],
          supervisorIntent: "named_procedure",
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
      ),
    ).toBe("faq__finalize");
  });

  it("does not open catalog on idle FAQ without named_procedure (price/info)", async () => {
    const faq = await createAgentPrepareNode("faq", {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("скільки коштує колаген")],
      servicesContext: {
        list: [
          {
            id: "svc-collagen",
            name: "Колагеностимуляція Полімолочна кислота",
          },
        ],
      },
      supervisorIntent: "faq",
    }));
    expect(faq.pendingInteraction).toBeUndefined();
    expect(faq.bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("does not open catalog on idle FAQ free text without supervisorIntent", async () => {
    const faq = await createAgentPrepareNode("faq", {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: botoxServices,
    }));
    expect(faq.pendingInteraction).toBeUndefined();
    expect(faq.bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("loads the catalog on named_procedure when servicesContext is empty", async () => {
    let loadCalls = 0;
    const faq = await createAgentPrepareNode("faq", {
      loadServices: async () => {
        loadCalls += 1;
        return botoxServices;
      },
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: null,
      supervisorIntent: "named_procedure",
    }));
    expect(loadCalls).toBe(1);
    expect(faq.pendingInteraction?.kind).toBe("service_candidate");
  });

  it("does not fetch the catalog on idle FAQ when servicesContext is empty without named_procedure", async () => {
    let loadCalls = 0;
    const faq = await createAgentPrepareNode("faq", {
      loadServices: async () => {
        loadCalls += 1;
        return botoxServices;
      },
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: null,
    }));
    expect(loadCalls).toBe(0);
    expect(faq.pendingInteraction).toBeUndefined();
  });

  it("accepts Так on FAQ-opened collagen service_confirm in booking prepare", async () => {
    const offered = await createAgentPrepareNode("faq")(clinicState({
      messages: [new HumanMessage("запиши на колаген")],
      servicesContext: {
        list: [
          {
            id: "svc-collagen",
            name: "Колагеностимуляція Полімолочна кислота",
            duration: 60,
          },
        ],
      },
      supervisorIntent: "named_procedure",
    }));
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const rendered = await createAgentFinalizeNode(faqAgent)(
      clinicState({
        messages: [new HumanMessage("запиши на колаген")],
        bookingDraft: offered.bookingDraft ?? null,
        pendingInteraction: offered.pendingInteraction ?? null,
        supervisorIntent: "named_procedure",
        agentMessages: [new HumanMessage("запиши на колаген")],
      }),
    );
    expect(rendered.lastHandoff?.replyText).toContain(
      "Колагеностимуляція Полімолочна кислота",
    );
    expect(rendered.lastHandoff?.replyText).toContain(
      "Бажаєте записатися на цю процедуру?",
    );
    expect(rendered.lastHandoff?.replyText).not.toContain(
      "Підібрати вільний час на консультацію?",
    );
    expect(rendered.lastHandoff?.replyButtons).toEqual(["Так", "Обрати іншу процедуру"]);
    expect(rendered.supervisorIntent).toBeNull();

    const accepted = await createAgentPrepareNode("booking")(clinicState({
      messages: [new HumanMessage("Так")],
      bookingDraft: offered.bookingDraft ?? null,
      pendingInteraction: offered.pendingInteraction ?? null,
      contactContext: ownedContact,
      bookingContext: { meetings: [], dateFrom: "2026-10-11" },
    }));
    expect(accepted.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: "svc-collagen" },
    });
    expect(accepted.bookingDraft?.serviceAcceptance?.service.id).not.toBe(
      CONSULTATION_SERVICE_ID,
    );
  });
});

describe("supervisor idle free text (no booking_entry pre-LLM)", () => {
  it("calls the supervisor LLM for named booking free text", async () => {
    const invoke = vi.fn(async () => ({ next: "faq", intent: "named_procedure" }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: null,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    });
    const update = await node(
      supervisorState({ messages: [new HumanMessage("запиши на колагеностимуляцію")] }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("faq");
    expect(update.supervisorIntent).toBe("named_procedure");
  });

  it("still skips the LLM for keyboard «Записатись» via sticky/chip paths when applicable", async () => {
    // Fresh «Записатись» with no sticky context reaches the LLM; model returns book.
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    });
    const update = await node(
      supervisorState({ messages: [new HumanMessage("Записатись")] }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
  });

  it("keeps model book when visits=none even if services match a named procedure", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("запиши на ботокс")],
        servicesContext: botoxServices,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
  });
});

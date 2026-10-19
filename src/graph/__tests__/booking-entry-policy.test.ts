import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_OFFER_MENU,
  BOOKING_OFFER_MENU_EN,
  BOOKING_REPLACE_MENU,
  CONSULTATION_SERVICE_ID,
  SERVICE_CONFIRM_CONSULTATION_EN,
} from "../../shared/clinic-constants.js";
import {
  createFaqPrepareNode,
  createBookingPrepareNode,
  createFaqFinalizeNode,
  createBookingFinalizeNode,
  routeAfterAgentPrepare,
} from "../agent-loop/index.js";
import {
  isCatalogEvidenceEligibleText,
  refineSupervisorNamedBooking,
  utteranceHasCatalogCrmEvidence,
} from "../booking-entry-policy.js";
import { createEmptyBookingDraft } from "../booking-draft.js";
import { resolveCatalogLexicalEvidence } from "../catalog-match.js";
import {
  consultationService,
  reduceBookingSession,
} from "../booking-session.js";
import type { ClinicState } from "../state.js";
import { FAQ_AGENT_ID, type ClinicAgentDefinition, type ILLMConnector } from "../types.js";
import { faqCatalogAi } from "./agent-loop-fixtures.js";
import {
  specialists,
  createClinicSupervisorNode,
  supervisorState,
} from "./supervisor-fixtures.js";

const openConsultationSession = () =>
  reduceBookingSession(
    { bookingDraft: null, pendingInteraction: null },
    {
      type: "service_offered",
      service: consultationService("catalog"),
    },
  );

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
  faqSkipLlm: false,
  bookingSchemaVersion: 1,
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
    const prepare = createBookingPrepareNode( {
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

    const rendered = await createBookingFinalizeNode(bookingAgent)(
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
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({ messages: [new HumanMessage("Записатись")] }),
    );
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    expect(false).toBe(true);
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

  it("does not reprint an open consultation card on unmatched free text", async () => {
    const consultation = openConsultationSession();
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("що входить у консультацію?")],
        bookingDraft: consultation.bookingDraft,
        pendingInteraction: consultation.pendingInteraction,
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    );
    expect(false).toBe(false);
    // Prepare leaves the open confirm in place (no wipe / no new card).
    expect(update.pendingInteraction ?? consultation.pendingInteraction)
      .toMatchObject({ kind: "service_confirm" });
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("що входить у консультацію?")],
          bookingDraft: consultation.bookingDraft,
          pendingInteraction: consultation.pendingInteraction,
          contactContext: ownedContact,
          bookingContext: { meetings: [], dateFrom: "2026-10-11" },
        }),
        "booking__llm",
        "booking__command_prepare",
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__llm");
  });

  it("keeps Так / choose_other / exact dates graph-owned on open consultation", async () => {
    const consultation = openConsultationSession();
    const prepare = createBookingPrepareNode();
    const accepted = await prepare(
      clinicState({
        messages: [new HumanMessage("Так")],
        bookingDraft: consultation.bookingDraft,
        pendingInteraction: consultation.pendingInteraction,
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    );
    expect(accepted.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    expect(accepted.pendingInteraction).toBeNull();
    expect(false).toBe(false);

    const declined = await prepare(
      clinicState({
        messages: [new HumanMessage("Обрати іншу процедуру")],
        bookingDraft: consultation.bookingDraft,
        pendingInteraction: consultation.pendingInteraction,
      }),
    );
    expect(declined.bookingDraft).toBeNull();
    expect(declined.pendingInteraction).toBeNull();

    const dated = await prepare(
      clinicState({
        messages: [new HumanMessage("20.10.2026")],
        bookingDraft: consultation.bookingDraft,
        pendingInteraction: consultation.pendingInteraction,
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
    );
    expect(dated.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(dated.bookingDraft?.selectedDate).toBe("2026-10-20");
  });

  it("opens consultation for idle booking when contact is owned and there is no visit", async () => {
    const prepare = createBookingPrepareNode();
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
    const prepare = createBookingPrepareNode( {
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
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({ messages: [new HumanMessage("Book")] }),
    );
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    if (update.pendingInteraction?.kind === "service_confirm") {
      expect(update.pendingInteraction.choices.map((choice) => choice.label)).toEqual([
        ...BOOKING_OFFER_MENU_EN,
      ]);
    }
    const rendered = await createBookingFinalizeNode(bookingAgent)(
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
    const update = await createBookingPrepareNode( {
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
    const faq = await createFaqPrepareNode( {
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
    expect(faq.faqSkipLlm).toBe(true);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на ботокс")],
          servicesContext: botoxServices,
          supervisorIntent: "named_procedure",
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__finalize");
  });

  it("opens service_confirm for a unique collagen row on named_procedure", async () => {
    const faq = await createFaqPrepareNode()(clinicState({
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
    expect(faq.faqSkipLlm).toBe(true);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на колаген")],
          supervisorIntent: "named_procedure",
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__finalize");
  });

  it("closes open consultation then opens singleton procedure confirm", async () => {
    const consultation = openConsultationSession();
    expect(consultation.bookingDraft?.serviceAcceptance?.service.id).toBe(
      CONSULTATION_SERVICE_ID,
    );
    const faq = await createFaqPrepareNode()(clinicState({
      messages: [new HumanMessage("набота 3 зони")],
      servicesContext: {
        list: [
          { id: "n3", name: "Ботулінотерапія Nabota 3 зони", duration: 45 },
          { id: "d1", name: "Ботулінотерапія Botox, Disport 1 зона" },
        ],
      },
      supervisorIntent: "named_procedure",
      bookingDraft: consultation.bookingDraft,
      pendingInteraction: consultation.pendingInteraction,
    }));
    expect(faq.pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: { id: "n3", name: "Ботулінотерапія Nabota 3 зони" },
    });
    expect(faq.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: "n3" },
    });
    expect(faq.bookingDraft?.serviceAcceptance?.service.id).not.toBe(
      CONSULTATION_SERVICE_ID,
    );
  });

  it("closes open consultation then opens family chips without leftover consultation", async () => {
    const consultation = openConsultationSession();
    const faq = await createFaqPrepareNode({
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("набота")],
      servicesContext: botoxServices,
      supervisorIntent: "named_procedure",
      bookingDraft: consultation.bookingDraft,
      pendingInteraction: consultation.pendingInteraction,
    }));
    expect(faq.pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
      consultationDeclined: true,
    });
    expect(faq.bookingDraft?.serviceAcceptance ?? null).toBeNull();
    expect(
      faq.pendingInteraction?.kind === "service_candidate"
        ? faq.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(expect.arrayContaining(["Nabota"]));
  });

  it("does not open catalog on idle FAQ without named_procedure (price/info)", async () => {
    const faq = await createFaqPrepareNode( {
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
    const faq = await createFaqPrepareNode( {
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
    const faq = await createFaqPrepareNode( {
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
    const faq = await createFaqPrepareNode( {
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

  it("rematches collagen off open Botox chips without named_procedure", async () => {
    const botoxChips = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "запиши на ботокс",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Botox, Disport", serviceIds: ["z1", "z2"] },
        { id: "g1", label: "Nabota", serviceIds: ["n1", "n2"] },
      ],
    };
    const services = {
      list: [
        ...botoxServices.list,
        {
          id: "svc-collagen",
          name: "Колагеностимуляція Полімолочна кислота",
          duration: 60,
        },
      ],
    };
    // Lexical-only (no family selector) — unique CRM stem hit → service_confirm.
    const faq = await createFaqPrepareNode()(clinicState({
      messages: [new HumanMessage("запиши на колаген")],
      servicesContext: services,
      pendingInteraction: botoxChips,
    }));
    expect(faq.pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: {
        id: "svc-collagen",
        name: "Колагеностимуляція Полімолочна кислота",
      },
    });
    expect(faq.faqSkipLlm).toBe(true);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на колаген")],
          servicesContext: services,
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__finalize");
  });

  it("keeps Botox chips and hits FAQ LLM on a price question", async () => {
    const botoxChips = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "запиши на ботокс",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Botox, Disport", serviceIds: ["z1", "z2"] },
        { id: "g1", label: "Nabota", serviceIds: ["n1", "n2"] },
      ],
    };
    const faq = await createFaqPrepareNode( {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("Скільки коштує?")],
      servicesContext: botoxServices,
      pendingInteraction: botoxChips,
    }));
    expect(faq.pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("Скільки коштує?")],
          servicesContext: botoxServices,
          pendingInteraction: botoxChips,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("does not call the family selector on compare prose with no CRM stems", async () => {
    const botoxChips = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "запиши на ботокс",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Botox, Disport", serviceIds: ["z1", "z2"] },
        { id: "g1", label: "Nabota", serviceIds: ["n1", "n2"] },
      ],
    };
    const selectCandidates = vi.fn(async () => ({
      serviceIds: ["z1", "z2", "n1", "n2"],
      groups: [
        { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
        { label: "Nabota", serviceIds: ["n1", "n2"] },
      ],
    }));
    const faq = await createFaqPrepareNode( {
      selectCandidates,
    })(clinicState({
      messages: [new HumanMessage("Порівняй ціни цих варіантів")],
      servicesContext: botoxServices,
      pendingInteraction: botoxChips,
    }));
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(faq.pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("Порівняй ціни цих варіантів")],
          servicesContext: botoxServices,
          pendingInteraction: botoxChips,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("hits FAQ LLM on a price question over an already-open service_confirm", () => {
    const openConfirm = {
      kind: "service_confirm" as const,
      service: {
        id: "z1",
        name: "Ботулінотерапія Botox, Disport 1 зона",
        source: "catalog" as const,
      },
      choices: [
        { id: "accept", label: "Так" },
        { id: "choose_other", label: "Обрати іншу процедуру" },
      ],
    };
    const draft = {
      ...createEmptyBookingDraft(),
      serviceAcceptance: {
        status: "pending" as const,
        service: openConfirm.service,
      },
    };
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("Скільки коштує?")],
          bookingDraft: draft,
          pendingInteraction: openConfirm,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("skips FAQ LLM when prepare opened service_confirm this turn", async () => {
    const faq = await createFaqPrepareNode()(clinicState({
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
    expect(faq.pendingInteraction?.kind).toBe("service_confirm");
    expect(faq.faqSkipLlm).toBe(true);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на колаген")],
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__finalize");
  });

  it("hits FAQ LLM on a service-name price question over an already-open confirm", async () => {
    const openConfirm = {
      kind: "service_confirm" as const,
      service: {
        id: "svc-neotiva",
        name: "Neotiva",
        source: "catalog" as const,
      },
      choices: [
        { id: "accept", label: "Так" },
        { id: "choose_other", label: "Обрати іншу процедуру" },
      ],
    };
    const draft = {
      ...createEmptyBookingDraft(),
      serviceAcceptance: {
        status: "pending" as const,
        service: openConfirm.service,
      },
    };
    const faq = await createFaqPrepareNode()(clinicState({
      messages: [new HumanMessage("скільки коштує Neotiva?")],
      bookingDraft: draft,
      pendingInteraction: openConfirm,
      servicesContext: {
        list: [{ id: "svc-neotiva", name: "Neotiva", duration: 60 }],
      },
    }));
    expect(faq.faqSkipLlm).toBe(false);
    expect(faq.pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("скільки коштує Neotiva?")],
          bookingDraft: draft,
          pendingInteraction: openConfirm,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("hits FAQ LLM when open service_confirm has no prepare skip flag", () => {
    const unnamedConfirm = {
      kind: "service_confirm" as const,
      service: {
        id: "svc-collagen",
        source: "catalog" as const,
      },
      choices: [
        { id: "accept", label: "Так" },
        { id: "choose_other", label: "Обрати іншу процедуру" },
      ],
    };
    const draft = {
      ...createEmptyBookingDraft(),
      serviceAcceptance: {
        status: "pending" as const,
        service: unnamedConfirm.service,
      },
    };
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на колаген")],
          bookingDraft: draft,
          pendingInteraction: unnamedConfirm,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("opens family chips for named_procedure with a trailing question mark", async () => {
    const faq = await createFaqPrepareNode( {
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("можна записатись на ботокс?")],
      servicesContext: botoxServices,
      supervisorIntent: "named_procedure",
    }));
    expect(faq.pendingInteraction?.kind).toBe("service_candidate");
    expect(faq.faqSkipLlm).toBe(true);
    expect(
      faq.pendingInteraction?.kind === "service_candidate"
        ? faq.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["Botox, Disport", "Nabota"]);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("можна записатись на ботокс?")],
          servicesContext: botoxServices,
          supervisorIntent: "named_procedure",
          bookingDraft: faq.bookingDraft ?? null,
          pendingInteraction: faq.pendingInteraction ?? null,
          faqSkipLlm: faq.faqSkipLlm === true,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__finalize");
  });

  it("routes FAQ detour to LLM while contact_field is open", () => {
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("скільки коштує консультація?")],
          bookingDraft: {
            ...createEmptyBookingDraft(),
            serviceAcceptance: {
              status: "accepted",
              service: { id: "svc-1", name: "Консультація", source: "catalog" },
            },
            selectedDate: "2026-09-10",
            selectedSlot: {
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
              label: "14:00",
            },
            note: { status: "skipped" },
            phase: "details",
          },
          pendingInteraction: {
            kind: "contact_field",
            field: "firstName",
            choices: [],
          },
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("does not rematch open chips on a trailing-question book line without named_procedure", async () => {
    const botoxChips = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "запиши на ботокс",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Botox, Disport", serviceIds: ["z1", "z2"] },
        { id: "g1", label: "Nabota", serviceIds: ["n1", "n2"] },
      ],
    };
    const selectCandidates = vi.fn(familySelector);
    const faq = await createFaqPrepareNode( {
      selectCandidates,
    })(clinicState({
      messages: [new HumanMessage("можна записатись на ботокс?")],
      servicesContext: botoxServices,
      pendingInteraction: botoxChips,
    }));
    expect(selectCandidates).not.toHaveBeenCalled();
    expect(faq.pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("можна записатись на ботокс?")],
          servicesContext: botoxServices,
          pendingInteraction: botoxChips,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("accepts Так on FAQ-opened collagen service_confirm in booking prepare", async () => {
    const offered = await createFaqPrepareNode()(clinicState({
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
    const rendered = await createFaqFinalizeNode(faqAgent)(
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

    const accepted = await createBookingPrepareNode()(clinicState({
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

  it("Botox chips → prices keep chips → набота 3 зони confirms Nabota, not consultation", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const chips = await createFaqPrepareNode({
      selectCandidates: familySelector,
    })(clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      servicesContext: botoxServices,
      supervisorIntent: "named_procedure",
    }));
    expect(chips.pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
    });

    const priced = await createFaqFinalizeNode(faqAgent)(
      clinicState({
        messages: [new HumanMessage("які ціни")],
        servicesContext: botoxServices,
        pendingInteraction: chips.pendingInteraction ?? null,
        agentMessages: [
          faqCatalogAi(
            "Вартість залежить від препарату:\n• Nabota 2 зони — 4 000 грн\n• Nabota 1 зона — 2 200 грн",
            "keep_catalog",
          ),
        ],
      }),
    );
    expect(priced.lastHandoff?.replyText).toContain("4 000 грн");
    expect(priced.lastHandoff?.replyText).not.toContain(
      "Підібрати вільний час на консультацію?",
    );
    expect(priced.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["Nabota"]),
    );
    expect(priced.lastHandoff?.replyButtons).not.toEqual([...BOOKING_OFFER_MENU]);

    // Recovery path: consultation card already open (pre-fix loop) + Cyrillic brand.
    const nabotaThree = {
      list: [
        { id: "n3", name: "Ботулінотерапія Nabota 3 зони", duration: 45 },
        { id: "d1", name: "Ботулінотерапія Botox, Disport 1 зона" },
      ],
    };
    const consultation = openConsultationSession();
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "набота 3 зони",
      hasVisit: false,
      services: nabotaThree.list,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });

    const switched = await createFaqPrepareNode()(clinicState({
      messages: [new HumanMessage("набота 3 зони")],
      servicesContext: nabotaThree,
      supervisorIntent: "named_procedure",
      bookingDraft: consultation.bookingDraft,
      pendingInteraction: consultation.pendingInteraction,
    }));
    expect(switched.pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: { id: "n3", name: "Ботулінотерапія Nabota 3 зони" },
    });
    expect(switched.bookingDraft?.serviceAcceptance?.service.id).toBe("n3");
    expect(switched.bookingDraft?.serviceAcceptance?.service.id).not.toBe(
      CONSULTATION_SERVICE_ID,
    );

    const rendered = await createFaqFinalizeNode(faqAgent)(
      clinicState({
        messages: [new HumanMessage("набота 3 зони")],
        bookingDraft: switched.bookingDraft ?? null,
        pendingInteraction: switched.pendingInteraction ?? null,
        supervisorIntent: "named_procedure",
        faqSkipLlm: true,
        agentMessages: [new HumanMessage("набота 3 зони")],
      }),
    );
    expect(rendered.lastHandoff?.replyText).toContain("Nabota 3 зони");
    expect(rendered.lastHandoff?.replyText).not.toContain(
      "Підібрати вільний час на консультацію?",
    );
    expect(rendered.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
  });
});

describe("refineSupervisorNamedBooking (post-LLM policy)", () => {
  const collagenServices = [{
    id: "svc-collagen",
    name: "Колагеностимуляція Полімолочна кислота",
    duration: 60,
  }];

  it("book + CRM stem, no visit → faq / named_procedure", async () => {
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "Хочу ботокс",
      hasVisit: false,
      services: botoxServices.list,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });
    expect(refined.catalogUnavailable).toBeUndefined();
  });

  it("book + Cyrillic набота over open consultation → faq / named_procedure", async () => {
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "набота 3 зони",
      hasVisit: false,
      services: botoxServices.list,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });
  });

  it("book + CRM stem, existing visit → booking (REPLACE, no guessed service)", async () => {
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "запиши на ботокс",
      hasVisit: true,
      services: botoxServices.list,
    });
    expect(refined.decision).toEqual({ next: "booking", intent: "book" });
  });

  it("book + terminal ? + CRM stem → catalog named_procedure", async () => {
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "Можна записатись на ботокс?",
      hasVisit: false,
      services: botoxServices.list,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });
  });

  it("book without CRM evidence → generic booking", async () => {
    const loadServices = vi.fn(async () => ({ list: botoxServices.list }));
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "хочу записатися",
      hasVisit: false,
      services: botoxServices.list,
      loadServices,
    });
    expect(refined.decision).toEqual({ next: "booking", intent: "book" });
    expect(loadServices).not.toHaveBeenCalled();
  });

  it("faq + CRM stem → no refinement and no catalog load", async () => {
    const loadServices = vi.fn(async () => ({ list: botoxServices.list }));
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "faq", intent: "faq" },
      patientText: "Скільки коштує ботокс?",
      hasVisit: false,
      services: undefined,
      loadServices,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "faq" });
    expect(loadServices).not.toHaveBeenCalled();
  });

  it("terminal price question yields lexical evidence only when explicitly requested", () => {
    const price = "Скільки коштує ботокс?";
    expect(
      resolveCatalogLexicalEvidence(price, botoxServices.list).rows,
    ).toEqual([]);
    expect(
      resolveCatalogLexicalEvidence(price, botoxServices.list, {
        allowTerminalQuestion: true,
      }).rows.length,
    ).toBeGreaterThan(0);
    expect(
      utteranceHasCatalogCrmEvidence({
        text: price,
        services: botoxServices.list,
      }),
    ).toBe(true);
  });

  it("named_procedure → direct FAQ route when idle", async () => {
    const loadServices = vi.fn(async () => ({ list: botoxServices.list }));
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "faq", intent: "named_procedure" },
      patientText: "запиши на ботокс",
      hasVisit: false,
      services: undefined,
      loadServices,
    });
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });
    expect(loadServices).not.toHaveBeenCalled();
  });

  it("named_procedure + existing visit → booking REPLACE", async () => {
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "faq", intent: "named_procedure" },
      patientText: "запиши на ботокс",
      hasVisit: true,
      services: botoxServices.list,
    });
    expect(refined.decision).toEqual({ next: "booking", intent: "book" });
  });

  it("cached services avoid another load", async () => {
    const loadServices = vi.fn(async () => ({ list: collagenServices }));
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "хочу колаген",
      hasVisit: false,
      services: collagenServices,
      loadServices,
    });
    expect(loadServices).not.toHaveBeenCalled();
    expect(refined.decision).toEqual({ next: "faq", intent: "named_procedure" });
    expect(refined.servicesContext).toBeUndefined();
  });

  it("catalog-load failure preserves the model route", async () => {
    const loadServices = vi.fn(async () => null);
    const refined = await refineSupervisorNamedBooking({
      decision: { next: "booking", intent: "book" },
      patientText: "хочу ботокс",
      hasVisit: false,
      services: [],
      loadServices,
    });
    expect(refined.decision).toEqual({ next: "booking", intent: "book" });
    expect(refined.catalogUnavailable).toBe(true);
    expect(loadServices).toHaveBeenCalledOnce();
  });
});

describe("supervisor idle free text (named_booking post-LLM refine)", () => {
  it("calls the LLM then lazy-loads catalog for book + CRM stem", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const loadServices = vi.fn(async () => ({
      list: [{
        id: "svc-collagen",
        name: "Колагеностимуляція Полімолочна кислота",
        duration: 60,
      }],
    }));
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: null,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("запиши на колаген")],
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).toHaveBeenCalledOnce();
    expect(update.next).toBe("faq");
    expect(update.supervisorIntent).toBe("named_procedure");
    expect(update.servicesContext?.list.map((row) => row.id)).toEqual(["svc-collagen"]);
  });

  it("reuses checkpointed servicesContext and does not reload", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const loadServices = vi.fn(async () => ({
      list: [{ id: "other", name: "Other" }],
    }));
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: null,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("запиши на колагеностимуляцію")],
        servicesContext: {
          list: [{
            id: "svc-collagen",
            name: "Колагеностимуляція Полімолочна кислота",
            duration: 60,
          }],
        },
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).not.toHaveBeenCalled();
    expect(update.next).toBe("faq");
    expect(update.supervisorIntent).toBe("named_procedure");
  });

  it("keeps generic «Записатись» on booking consultation", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const loadServices = vi.fn(async () => botoxServices);
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({ messages: [new HumanMessage("Записатись")] }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).not.toHaveBeenCalled();
    expect(update.next).toBe("booking");
    expect(update.supervisorIntent).toBeNull();
  });

  it("does not treat «Записатись» as CRM evidence when catalog has запис* titles", async () => {
    const zapisCatalog = {
      list: [
        { id: "svc-zapis", name: "Запис консультації", duration: 30 },
        ...botoxServices.list,
      ],
    };
    expect(isCatalogEvidenceEligibleText("Записатись")).toBe(false);
    expect(isCatalogEvidenceEligibleText("хочу ботокс")).toBe(true);
    expect(
      utteranceHasCatalogCrmEvidence({
        text: "Записатись",
        services: zapisCatalog.list,
      }),
    ).toBe(false);

    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const loadServices = vi.fn(async () => zapisCatalog);
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Записатись")],
        servicesContext: zapisCatalog,
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).not.toHaveBeenCalled();
    expect(update.next).toBe("booking");
    expect(update.supervisorIntent).toBeNull();
  });

  it("routes idle named booking to FAQ catalog, not booking consultation", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const node = createClinicSupervisorNode({
      specialists,
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
    expect(update.next).toBe("faq");
    expect(update.supervisorIntent).toBe("named_procedure");
  });

  it("routes named booking with an existing visit to REPLACE without guessing a service", async () => {
    const invoke = vi.fn(async () => ({ next: "faq", intent: "named_procedure" }));
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: listedMeetings,
      }),
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("запиши на ботокс")],
        servicesContext: botoxServices,
        bookingContext: listedMeetings,
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
    expect(update.supervisorIntent).toBeNull();
    expect(update.bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("leaves price questions on FAQ LLM without catalog inspect", async () => {
    const invoke = vi.fn(async () => ({ next: "faq", intent: "faq" }));
    const loadServices = vi.fn(async () => botoxServices);
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Скільки коштує ботокс?")],
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).not.toHaveBeenCalled();
    expect(update.next).toBe("faq");
    expect(update.supervisorIntent).toBeNull();
  });

  it("preserves model book when catalog load fails", async () => {
    const invoke = vi.fn(async () => ({ next: "booking", intent: "book" }));
    const loadServices = vi.fn(async () => {
      throw new Error("CRM down");
    });
    const node = createClinicSupervisorNode({
      specialists,
      supervisorLlm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: ownedContact,
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
      }),
      loadServices,
    });
    const update = await node(
      supervisorState({
        messages: [new HumanMessage("хочу ботокс")],
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(loadServices).toHaveBeenCalledOnce();
    expect(update.next).toBe("booking");
    expect(update.supervisorIntent).toBeNull();
  });
});

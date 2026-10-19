import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createFaqPrepareNode,
  createBookingPrepareNode,
  createFaqFinalizeNode,
  createBookingFinalizeNode,
  routeAfterAgentPrepare,
} from "../agent-loop/index.js";
import {
  BOOKING_OFFER_MENU,
  CONSULTATION_SERVICE_ID,
} from "../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import {
  FAQ_AGENT_ID,
  type ClinicAgentDefinition,
} from "../types.js";

import {
  canonicalBookingDraft,
  clinicState,
  faqCatalogAi,
  makeListedMeetings,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";


describe("agent-loop catalog (prepare+finalize)", () => {
  it("does not clear servicesContext when preparing FAQ", async () => {
    const prepare = createFaqPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Послуги")],
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
      }),
    );
    expect(update.servicesContext).toBeUndefined();
  });

  it("opens FAQ catalog chips on Обрати іншу процедуру via partitioner in prepare", async () => {
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async (input) => {
        expect(input.query).toContain("напрями");
        return [
          {
            label: "Ін'єкційні процедури",
            serviceIds: ["svc-lip", "svc-botox"],
          },
          {
            label: "Дерматологічні послуги та догляд",
            serviceIds: ["svc-derm"],
          },
        ];
      },
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Обрати іншу процедуру")],
        servicesContext: {
          list: [
            { id: "svc-lip", name: "збільшення губ" },
            { id: "svc-botox", name: "ботулінотерапія" },
            { id: "svc-derm", name: "Видалення новоутворень" },
          ],
        },
        pendingInteraction: {
          kind: "service_confirm",
          service: { id: "consult", name: "Консультація", source: "catalog" },
          choices: [
            { id: "yes", label: "Так" },
            { id: "other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      owner: "faq",
      consultationDeclined: true,
    });
    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual([
      "Ін'єкційні процедури",
      "Видалення новоутворень",
    ]);
  });

  it("opens FAQ catalog chips on bare НІ after a consultation offer", async () => {
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [
        { label: "Ін'єкційні процедури", serviceIds: ["svc-collagen"] },
        { label: "Дерматологія", serviceIds: ["svc-derm"] },
      ],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("НІ")],
        servicesContext: {
          list: [
            { id: "svc-collagen", name: "Колагеностимуляція Полімолочна кислота" },
            { id: "svc-derm", name: "Видалення новоутворень" },
          ],
        },
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            {
              id: "choose_other",
              label: "Обрати іншу процедуру",
              aliases: ["ні", "нi", "no", "не треба"],
            },
          ],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
      consultationDeclined: true,
    });
  });

  it("does not wipe open FAQ catalog chips on bare ні", async () => {
    const root = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "catalog",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Ін'єкційні процедури", serviceIds: ["svc-collagen"] },
        { id: "g1", label: "Дерматологія", serviceIds: ["svc-derm"] },
      ],
    };
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [
        { label: "Root wipe", serviceIds: ["svc-collagen", "svc-derm"] },
      ],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("ні")],
        servicesContext: {
          list: [
            { id: "svc-collagen", name: "Колагеностимуляція" },
            { id: "svc-derm", name: "Видалення новоутворень" },
          ],
        },
        pendingInteraction: root,
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("ні")],
          pendingInteraction: root,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");
  });

  it("does not auto-accept an open offer on bare digits", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("14")],
        bookingDraft: canonicalBookingDraft({
          phase: "service",
          serviceAcceptance: {
            status: "pending",
            service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
          },
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
        }),
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.status).toBe("pending");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate ?? null).toBeNull();
  });

  it("does not auto-accept an open offer on anchored bare day with DATE snapshot", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("14")],
        bookingDraft: canonicalBookingDraft({
          phase: "service",
          serviceAcceptance: {
            status: "pending",
            service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
          },
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
        }),
        availabilityContext: {
          days: [
            {
              date: "2026-10-14",
              slots: [
                {
                  dateStart: "2026-10-14T10:00:00",
                  dateEnd: "2026-10-14T10:30:00",
                  label: "10:00",
                },
              ],
            },
            {
              date: "2026-10-15",
              slots: [
                {
                  dateStart: "2026-10-15T11:00:00",
                  dateEnd: "2026-10-15T11:30:00",
                  label: "11:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.status).toBe("pending");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate ?? null).toBeNull();
  });

  it("offers collagen via open_catalog when the FAQ model names the procedure", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const services = {
      list: [
        {
          id: "svc-collagen",
          name: "Колагеностимуляція Полімолочна кислота",
          duration: 60,
        },
        { id: "svc-botox", name: "Ботулінотерапія Botox 1 зона" },
      ],
    };
    const update = await createFaqFinalizeNode(faqAgent)(
      clinicState({
        messages: [new HumanMessage("запиши на коллаген")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [
          new AIMessage(
            'Обрано колаген.\n<faq_catalog_action action="open_catalog" query="колаген"/>',
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: {
        id: "svc-collagen",
        name: "Колагеностимуляція Полімолочна кислота",
      },
    });
  });

  it("offers collagen via open_catalog after a named decline line", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const update = await createFaqFinalizeNode(faqAgent)(
      clinicState({
        messages: [new HumanMessage("ні, запиши на колагеностимуляцію")],
        servicesContext: {
          list: [
            {
              id: "svc-collagen",
              name: "Колагеностимуляція Полімолочна кислота",
              duration: 60,
            },
          ],
        },
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            {
              id: "choose_other",
              label: "Обрати іншу процедуру",
              aliases: ["ні", "нi", "no", "не треба"],
            },
          ],
        },
        agentMessages: [
          new AIMessage(
            'Обрано.\n<faq_catalog_action action="open_catalog" query="колагеностимуляцію"/>',
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: { id: "svc-collagen" },
    });
  });

  it("loads the catalog before opening chips when Обрати іншу процедуру is the first catalog touch", async () => {
    const loadServices = vi.fn(async () => ({
      list: [
        { id: "svc-lip", name: "збільшення губ" },
        { id: "svc-derm", name: "Видалення новоутворень" },
      ],
    }));
    const prepare = createFaqPrepareNode( {
      loadServices,
      partitionCandidates: async () => [
        { label: "Ін'єкційні процедури", serviceIds: ["svc-lip"] },
        { label: "Дерматологія", serviceIds: ["svc-derm"] },
      ],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Обрати іншу процедуру")],
        servicesContext: null,
        pendingInteraction: {
          kind: "service_confirm",
          service: { id: "consult", name: "Консультація", source: "catalog" },
          choices: [
            { id: "yes", label: "Так" },
            { id: "other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );

    expect(loadServices).toHaveBeenCalledTimes(1);
    expect(update.servicesContext?.list).toHaveLength(2);
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
      consultationDeclined: true,
    });
  });

  it("does not open FAQ catalog on Послуги in prepare", async () => {
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [
        { label: "should-not-open", serviceIds: ["svc-1", "svc-2"] },
      ],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Послуги")],
        servicesContext: {
          list: [
            { id: "svc-1", name: "Консультація" },
            { id: "svc-2", name: "Botox" },
          ],
        },
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
  });

  it("keeps Пілінг labels after a direction chip that was not that family", async () => {
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Доглядові процедури")],
        servicesContext: {
          list: [
            { id: "p1", name: "Пілінг поверхневий" },
            { id: "p2", name: "Пілінг серединний" },
          ],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          choices: [
            {
              id: "g0",
              label: "Доглядові процедури",
              serviceIds: ["p1", "p2"],
            },
          ],
        },
      }),
    );

    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["Пілінг поверхневий", "Пілінг серединний"]);
  });

  it("strips Пілінг only after the patient chose Пілінг", async () => {
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [],
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Пілінг")],
        servicesContext: {
          list: [
            { id: "p1", name: "Пілінг поверхневий" },
            { id: "p2", name: "Пілінг серединний" },
          ],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          choices: [
            {
              id: "g0",
              label: "Пілінг",
              serviceIds: ["p1", "p2"],
            },
          ],
        },
      }),
    );

    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["поверхневий", "серединний"]);
  });

  it("leaves unmatched mid-catalog text for the FAQ model (no phrase matcher)", async () => {
    const openCatalog = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "Botox, Disport",
      choices: [
        { id: "z1", label: "1 зона", serviceIds: ["z1"] },
        { id: "z2", label: "2 зони", serviceIds: ["z2"] },
        { id: "ff", label: "Full Face", serviceIds: ["z1", "z2"] },
      ],
    };
    const prepare = createFaqPrepareNode();
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("не знаю")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
          ],
        },
        pendingInteraction: openCatalog,
      }),
    );

    // Hedge text is not chip-matched — prepare leaves the open catalog alone.
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toBeUndefined();
  });

  it("rematches Ботулінотерапія brand chips from open root catalog free text", async () => {
    const familyIds = ["corr", "meso", "z1", "z2", "n1", "n2"] as const;
    let selectCalls = 0;
    let selectCandidateCount = 0;
    const selectCandidates = async (input: {
      candidates: Array<{ id: string }>;
    }) => {
      selectCalls += 1;
      selectCandidateCount = input.candidates.length;
      return {
        serviceIds: [...familyIds],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
          { label: "Інше", serviceIds: ["corr", "meso"] },
        ],
      };
    };
    const services = {
      list: [
        { id: "c1", name: "Консультація первинна" },
        { id: "corr", name: "Корекція ботокс" },
        { id: "meso", name: "Мезоботокс" },
        { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
        { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
        { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
        { id: "n2", name: "Ботулінотерапія Nabota 2 зони" },
        { id: "p1", name: "Пілінг поверхневий" },
      ],
    };
    const rootChoices = [
      {
        id: "g0",
        label: "Консультації та діагностика",
        serviceIds: ["c1"],
      },
      {
        id: "g1",
        label: "Ін'єкційна косметологія",
        serviceIds: ["corr", "meso", "z1", "z2", "n1", "n2"],
      },
      {
        id: "g2",
        label: "Доглядові процедури",
        serviceIds: ["p1"],
      },
    ];
    const prepare = createFaqPrepareNode( { selectCandidates });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("ботокс")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          consultationDeclined: true,
          choices: rootChoices,
        },
      }),
    );
    // Mid-catalog rematch: unmatched prose → openCatalogFromFreeText.
    expect(selectCalls).toBe(1);
    expect(selectCandidateCount).toBe(services.list.length);
    expect(unwrapCommandUpdate(prepared).pendingInteraction?.kind).toBe("service_candidate");
    const preparedNarrowed =
      unwrapCommandUpdate(prepared).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(prepared).pendingInteraction
        : null;
    expect(preparedNarrowed?.owner).toBe("faq");
    expect(preparedNarrowed?.consultationDeclined).toBe(true);
    const preparedLabels = preparedNarrowed?.choices.map((c) => c.label) ?? [];
    expect(preparedLabels).toEqual(
      expect.arrayContaining(["Botox, Disport", "Nabota", "Інше"]),
    );
    expect(preparedLabels).not.toContain("Корекція ботокс");
    expect(preparedLabels).not.toContain("Мезоботокс");
    expect(preparedLabels).not.toContain(BOOKING_OFFER_MENU[0]);

    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent, { selectCandidates });
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("ботокс")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          consultationDeclined: true,
          choices: rootChoices,
        },
        agentMessages: [
          new AIMessage(
            'В ін\'єкційній косметології доступні такі варіанти ботулінотерапії:\n'
            + '<faq_catalog_action action="open_catalog" query="ботокс"/>',
          ),
        ],
      }),
    );
    expect(selectCalls).toBe(2);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    const narrowed =
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction
        : null;
    expect(narrowed?.owner).toBe("faq");
    expect(narrowed?.consultationDeclined).toBe(true);
    const labels = narrowed?.choices.map((c) => c.label) ?? [];
    expect(labels).toEqual(expect.arrayContaining(["Botox, Disport", "Nabota", "Інше"]));
    expect(labels).not.toContain("Корекція ботокс");
    expect(labels).not.toContain("Мезоботокс");
    expect(labels).not.toContain(BOOKING_OFFER_MENU[0]);
    expect(update.lastHandoff?.replyButtons).toEqual(labels);
  });

  it("expands already-narrow chips via open_catalog query on full catalog", async () => {
    let selectCandidateIds: string[] = [];
    const selectCandidates = async (input: {
      candidates: Array<{ id: string }>;
    }) => {
      selectCandidateIds = input.candidates.map((row) => row.id);
      return {
        serviceIds: ["corr", "meso", "z1", "z2", "n1", "n2"],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
          { label: "Інше", serviceIds: ["corr", "meso"] },
        ],
      };
    };
    const services = {
      list: [
        { id: "corr", name: "Корекція ботокс" },
        { id: "meso", name: "Мезоботокс" },
        { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
        { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
        { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
        { id: "n2", name: "Ботулінотерапія Nabota 2 зони" },
      ],
    };
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const update = await createFaqFinalizeNode(faqAgent, { selectCandidates })(
      clinicState({
        messages: [new HumanMessage("ботулінотерапія")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ботокс",
          consultationDeclined: true,
          choices: [
            { id: "corr", label: "Корекція ботокс", serviceIds: ["corr"] },
            { id: "meso", label: "Мезоботокс", serviceIds: ["meso"] },
          ],
        },
        agentMessages: [
          new AIMessage(
            'Ось бренди:\n<faq_catalog_action action="open_catalog" query="ботулінотерапія"/>',
          ),
        ],
      }),
    );
    expect(selectCandidateIds).toEqual(["corr", "meso", "z1", "z2", "n1", "n2"]);
    const labels =
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [];
    expect(labels).toEqual(expect.arrayContaining(["Botox, Disport", "Nabota", "Інше"]));
    expect(labels).not.toEqual(["Корекція ботокс", "Мезоботокс"]);
  });

  it("offers exact CRM name via open_catalog without calling selectCandidates", async () => {
    let selectCalls = 0;
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const update = await createFaqFinalizeNode(faqAgent, {
      selectCandidates: async () => {
        selectCalls += 1;
        return { serviceIds: ["z1", "n1"] };
      },
    })(
      clinicState({
        messages: [new HumanMessage("Корекція ботокс")],
        servicesContext: {
          list: [
            { id: "corr", name: "Корекція ботокс" },
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
          ],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "catalog",
          consultationDeclined: true,
          choices: [
            { id: "g0", label: "Ін'єкційна", serviceIds: ["corr", "z1", "n1"] },
          ],
        },
        agentMessages: [
          new AIMessage(
            'Обрано:\n<faq_catalog_action action="open_catalog" query="Корекція ботокс"/>',
          ),
        ],
      }),
    );
    expect(selectCalls).toBe(0);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_confirm"
        ? unwrapCommandUpdate(update).pendingInteraction.service.id
        : null,
    ).toBe("corr");
  });

  it("narrows open service_confirm via open_catalog query", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const update = await createFaqFinalizeNode(faqAgent, {
      selectCandidates: async () => ({
        serviceIds: ["z1", "z2", "n1", "n2", "corr", "meso"],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
        ],
      }),
    })(
      clinicState({
        messages: [new HumanMessage("ботокс")],
        servicesContext: {
          list: [
            // Stem «ботокс» hits these; selector expands to brand/zone siblings.
            { id: "corr", name: "Корекція ботокс" },
            { id: "meso", name: "Мезоботокс" },
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
            { id: "n2", name: "Ботулінотерапія Nabota 2 зони" },
          ],
        },
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [
          new AIMessage(
            'Варіанти ботоксу:\n<faq_catalog_action action="open_catalog" query="ботокс"/>',
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    const labels =
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [];
    expect(labels).toEqual(expect.arrayContaining(["Botox, Disport", "Nabota"]));
    expect(labels).not.toContain(BOOKING_OFFER_MENU[0]);
  });

  it("does not call selectCandidates for «що таке Disport?» on open catalog", async () => {
    let selectCalls = 0;
    const root = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "catalog",
      consultationDeclined: true,
      choices: [
        { id: "g0", label: "Ін'єкційна косметологія", serviceIds: ["z1", "n1"] },
      ],
    };
    const prepare = createFaqPrepareNode( {
      selectCandidates: async () => {
        selectCalls += 1;
        return { serviceIds: ["z1", "n1"] };
      },
    });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("що таке Disport?")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
          ],
        },
        pendingInteraction: root,
      }),
    );
    expect(selectCalls).toBe(0);
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toBeUndefined();
  });

  it("opens FAQ family chips from open_catalog tag (idle browse)", async () => {
    const services = {
      list: [
        { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
        { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
        { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
        { id: "n2", name: "Ботулінотерапія Nabota 2 зони" },
        { id: "c1", name: "Корекція ботокс" },
        { id: "m1", name: "Мезоботокс" },
      ],
    };
    const prepare = createFaqPrepareNode( {
      selectCandidates: async () => ({
        serviceIds: ["z1", "z2", "n1", "n2", "c1", "m1"],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
        ],
      }),
    });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("запиши на ботокс")],
        servicesContext: services,
      }),
    );
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("запиши на ботокс")],
          servicesContext: services,
        }),
        "faq__llm",
        undefined,
        undefined,
        "faq__finalize",
        FAQ_AGENT_ID,
      ),
    ).toBe("faq__llm");

    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "FAQ",
      systemPrompt: "faq",
      maxSteps: 6,
    };
    const finalize = createFaqFinalizeNode(faqAgent, {
      selectCandidates: async () => ({
        serviceIds: ["z1", "z2", "n1", "n2", "c1", "m1"],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
        ],
      }),
    });
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("запиши на ботокс")],
        servicesContext: services,
        agentMessages: [
          new AIMessage(
            'Можу показати варіанти.\n<faq_catalog_action action="open_catalog" query="ботокс"/>',
          ),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.owner
        : null,
    ).toBe("faq");
    expect(
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.consultationDeclined
        : null,
    ).toBe(true);
    const labels =
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [];
    expect(update.lastHandoff?.replyButtons).toEqual(labels);
    expect(labels).toEqual(expect.arrayContaining(["Botox, Disport", "Nabota"]));
    expect(update.lastHandoff?.replyButtons).not.toContain(BOOKING_OFFER_MENU[0]);
    expect(update.lastHandoff?.replyText).toContain("•");
  });

  it("does not open catalog chips from idle booking prepare on «запиши на ботокс»", async () => {
    const prepare = createBookingPrepareNode( {
      selectCandidates: async () => ({
        serviceIds: ["z1", "z2", "n1", "n2"],
        groups: [
          { label: "Botox, Disport", serviceIds: ["z1", "z2"] },
          { label: "Nabota", serviceIds: ["n1", "n2"] },
        ],
      }),
    });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("запиши на ботокс")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
          ],
        },
        bookingContext: { meetings: [], dateFrom: "2026-10-11" },
        contactContext: { contacts: [] },
      }),
    );
    expect(unwrapCommandUpdate(prepared).pendingInteraction?.kind ?? null).not.toBe("service_candidate");
    expect(unwrapCommandUpdate(prepared).bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("reopens FAQ catalog chips via open_catalog after a brand on consultation offer", async () => {
    const selectCandidates = async () => ({
      serviceIds: ["z1", "z2"],
      groups: [
        { label: "1 зона", serviceIds: ["z1"] },
        { label: "2 зони", serviceIds: ["z2"] },
      ],
    });
    const services = {
      list: [
        { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона (очі або міжбрів'я)" },
        { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
        { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
      ],
    };
    const prepare = createFaqPrepareNode( { selectCandidates });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("botox")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toBeUndefined();

    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent, { selectCandidates });
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("botox")],
        servicesContext: services,
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [
          new AIMessage(
            [
              "Для Botox/Disport доступні варіанти за зонами:",
              "• 1 зона (очі або міжбрів'я)",
              "• 2 зони",
              "",
              '<faq_catalog_action action="open_catalog" query="botox"/>',
            ].join("\n"),
          ),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    const preparedLabels =
      unwrapCommandUpdate(update).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(update).pendingInteraction.choices.map((c) => c.label)
        : [];
    expect(preparedLabels.length).toBeGreaterThan(1);
    expect(preparedLabels).not.toEqual([...BOOKING_OFFER_MENU]);

    expect(update.lastHandoff?.replyButtons).toEqual(preparedLabels);
    expect(update.lastHandoff?.replyButtons).not.toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("Який варіант вам підходить?");
    expect(update.lastHandoff?.replyText).toContain("Для Botox/Disport доступні варіанти за зонами:");
    expect(update.lastHandoff?.replyText).not.toContain("Підібрати вільний час на консультацію?");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
  });


  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("does not open FAQ catalog chips from list_services alone in finalize", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        bookingContext: makeListedMeetings(),
        servicesContext: {
          list: [
            { id: "svc-lip", name: "збільшення губ" },
            { id: "svc-botox", name: "ботулінотерапія" },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              list: [
                { id: "svc-lip", name: "збільшення губ" },
                { id: "svc-botox", name: "ботулінотерапія" },
              ],
            }),
            name: "list_services",
            tool_call_id: "ls-1",
          }),
          new AIMessage("Ось доступні процедури."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).not.toBe("service_candidate");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("attaches BOOKING OFFER on Послуги (not catalog chips) even with leftover mutation_confirm", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        bookingContext: makeListedMeetings(),
        servicesContext: {
          list: [
            { id: "svc-lip", name: "збільшення губ" },
            { id: "svc-botox", name: "ботулінотерапія" },
          ],
        },
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "cancel",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          new AIMessage(
            "У нашій клініці доступні такі напрями:\n\n• Консультації\n\nЗаписати вас на консультацію?",
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("У нашій клініці доступні такі напрями");
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(update.lastHandoff?.replyText).not.toContain("Записати вас на консультацію?");
    expect(update.lastHandoff?.replyText?.trimStart().startsWith("•")).toBe(false);
  });

  it("appends a consultation offer on Послуги when the model only asked which direction", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        bookingContext: makeListedMeetings(),
        servicesContext: {
          list: [
            { id: "svc-lip", name: "збільшення губ" },
            { id: "svc-botox", name: "ботулінотерапія" },
          ],
        },
        agentMessages: [
          new AIMessage(
            "У нашій клініці доступні такі напрями:\n\n• Консультації та діагностика\n• Ін'єкційні процедури\n\nЯкий напрямок вам цікавий?",
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("У нашій клініці доступні такі напрями");
    // Graph owns the only trailing question when service_confirm opens.
    expect(update.lastHandoff?.replyText).not.toContain("Який напрямок вам цікавий?");
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(
      (update.lastHandoff?.replyText ?? "")
        .split("Підібрати вільний час на консультацію?").length - 1,
    ).toBe(1);
    expect((update.lastHandoff?.replyText ?? "").match(/\?/g)?.length).toBe(1);
  });

  it("replaces divergent model FAQ catalog prose with structured-choice bullets", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Схуднення консультація", serviceIds: ["a", "b"] },
      { id: "g1", label: "Загальні", serviceIds: ["c", "d"] },
    ];
    const modelProse = [
      "Доступні такі варіанти:",
      "",
      "• Консультація первинна",
      "• Консультація повторна",
      "",
      "Який варіант вам підходить?",
    ].join("\n");
    const update = await finalize(
      clinicState({
        stepCount: 1,
        bookingContext: makeListedMeetings(),
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Консультації",
          choices,
        },
        agentMessages: [faqCatalogAi(modelProse)],
      }),
    );

    const expectedButtons = choices.map((c) => c.label);
    expect(update.lastHandoff?.replyButtons).toEqual(expectedButtons);
    expect(update.lastHandoff?.replyText).toBe(
      [
        "Доступні такі варіанти:",
        "",
        "• Схуднення консультація",
        "• Загальні",
        "",
        "Який варіант вам підходить?",
      ].join("\n"),
    );
    expect(update.lastHandoff?.replyText).not.toContain("Консультація первинна");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
    expect(String(update.messages?.[0]?.content)).not.toContain("faq_catalog_action");
  });

  it("keep_catalog retains a sanitized model explanation ahead of structured bullets", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Neotiva", serviceIds: ["n"] },
      { id: "g1", label: "Juvederm", serviceIds: ["j"] },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ціна губ",
          choices,
        },
        agentMessages: [
          faqCatalogAi(
            "Філери для губ коштують від 4500 грн залежно від препарату.\n\n• Wrong bullet\n\nЯкий варіант вам підходить?",
            "keep_catalog",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain(
      "Філери для губ коштують від 4500 грн залежно від препарату.",
    );
    expect(update.lastHandoff?.replyText).toContain("• Neotiva");
    expect(update.lastHandoff?.replyText).toContain("• Juvederm");
    expect(update.lastHandoff?.replyText).not.toContain("Wrong bullet");
    expect(update.lastHandoff?.replyText).toContain("Який варіант вам підходить?");
    expect(update.lastHandoff?.replyButtons).toEqual(["Neotiva", "Juvederm"]);
  });

  it("keep_catalog falls back to the graph intro when the model only asked a question", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Neotiva", serviceIds: ["n"] },
      { id: "g1", label: "Juvederm", serviceIds: ["j"] },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "губи",
          choices,
        },
        agentMessages: [
          faqCatalogAi("Який препарат вас цікавить?", "keep_catalog"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("Доступні такі варіанти:");
    expect(update.lastHandoff?.replyText).not.toContain("Який препарат вас цікавить?");
    expect(update.lastHandoff?.replyText).toContain("• Neotiva");
    expect(update.lastHandoff?.replyButtons).toEqual(["Neotiva", "Juvederm"]);
  });

  it("keeps FAQ catalog chips when draft still has a pending serviceAcceptance", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Обрати іншу процедуру")],
        bookingDraft: canonicalBookingDraft({
          phase: "service",
          serviceAcceptance: {
            status: "pending",
            service: {
              id: "svc-peel",
              name: "Пілінг поверхневий",
              source: "catalog",
            },
          },
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
        }),
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Обрати іншу процедуру",
          choices: [
            { id: "g0", label: "Консультації та діагностика", serviceIds: ["svc-c"] },
            { id: "g1", label: "Доглядові процедури", serviceIds: ["svc-p1", "svc-p2"] },
          ],
        },
        agentMessages: [new AIMessage("Який варіант вам підходить?")],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([
      "Консультації та діагностика",
      "Доглядові процедури",
    ]);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).not.toBe("service_confirm");
    expect(update.lastHandoff?.replyButtons).not.toEqual([...BOOKING_OFFER_MENU]);
  });

  it("attaches напрями chips after second Обрати іншу процедуру via prepare+finalize", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const prepare = createFaqPrepareNode( {
      partitionCandidates: async () => [
        {
          label: "Консультації та діагностика",
          serviceIds: ["svc-c1", "svc-c2"],
        },
        {
          label: "Доглядові процедури",
          serviceIds: ["svc-p1", "svc-p2"],
        },
      ],
    });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("Обрати іншу процедуру")],
        servicesContext: {
          list: [
            { id: "svc-c1", name: "Консультація первинна" },
            { id: "svc-c2", name: "Консультація повторна" },
            { id: "svc-p1", name: "Пілінг поверхневий" },
            { id: "svc-p2", name: "Пілінг серединний" },
          ],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "service",
          serviceAcceptance: {
            status: "pending",
            service: {
              id: "svc-p1",
              name: "Пілінг поверхневий",
              source: "catalog",
            },
          },
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
        }),
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: "svc-p1",
            name: "Пілінг поверхневий",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );

    expect(unwrapCommandUpdate(prepared).pendingInteraction?.kind).toBe("service_candidate");

    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Обрати іншу процедуру")],
        bookingDraft: unwrapCommandUpdate(prepared).bookingDraft ?? canonicalBookingDraft({
          phase: "service",
          serviceAcceptance: {
            status: "pending",
            service: {
              id: "svc-p1",
              name: "Пілінг поверхневий",
              source: "catalog",
            },
          },
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
        }),
        pendingInteraction: unwrapCommandUpdate(prepared).pendingInteraction ?? null,
        agentMessages: [
          new AIMessage(
            [
              // Stale previous-step prose the model often reprints after choose_other.
              "Для ботулінотерапії Nabota доступні такі зони:",
              "• 1 зона",
              "• 2 зони",
              "• FULL FACE",
              "",
              "Яка зона вас цікавить?",
                          ].join("\n"),
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([
      "Консультації та діагностика",
      "Доглядові процедури",
    ]);
    // Graph owns the body on choose_other so bullets match root chips.
    expect(update.lastHandoff?.replyText).toBe(
      "Доступні такі варіанти:\n\n• Консультації та діагностика\n• Доглядові процедури\n\nЯкий варіант вам підходить?",
    );
    expect(update.lastHandoff?.replyText).not.toContain("Nabota");
    expect(update.lastHandoff?.replyText).not.toContain("зона");
  });

  it("keeps FAQ catalog choice ids when narrowing remaining CRM rows", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);

    const families = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ін'єкції",
          choices: [
            { id: "g0", label: "збільшення губ", serviceIds: ["svc-lip"] },
            { id: "g1", label: "ботулінотерапія", serviceIds: ["svc-b1", "svc-b2"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(
            [
              "В ін'єкційних є кілька процедур:",
              "• збільшення губ",
              "• ботулінотерапія",
              "",
              "Яка процедура вас цікавить?",
            ].join("\n"),
            "keep_catalog",
          ),
        ],
      }),
    );
    expect(families.lastHandoff?.replyButtons).toEqual(["збільшення губ", "ботулінотерапія"]);
    expect(families.lastHandoff?.replyText).toContain("збільшення губ");
    expect(families.lastHandoff?.replyText).toContain("Який варіант вам підходить?");
    expect(families.lastHandoff?.replyText).toContain("В ін'єкційних є кілька процедур:");

    const zones = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ботулінотерапія",
          choices: [
            { id: "svc-b1", label: "1 зона", serviceIds: ["svc-b1"] },
            { id: "svc-b2", label: "2 зони", serviceIds: ["svc-b2"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(
            [
              "Для ботулінотерапії є варіанти за зонами:",
              "• 1 зона",
              "• 2 зони",
              "",
              "Який варіант вам підходить?",
            ].join("\n"),
            "keep_catalog",
          ),
        ],
      }),
    );
    expect(zones.lastHandoff?.replyButtons).toEqual(["1 зона", "2 зони"]);
    expect(zones.lastHandoff?.replyText).toContain("1 зона");

    const brands = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ботулінотерапія 1 зона",
          choices: [
            { id: "svc-d", label: "Disport", serviceIds: ["svc-d"] },
            { id: "svc-n", label: "Nabota", serviceIds: ["svc-n"] },
            { id: "svc-b", label: "Botox", serviceIds: ["svc-b"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(
            [
              "Є кілька препаратів:",
              "• Disport",
              "• Nabota",
              "• Botox",
              "",
              "Який препарат обираєте?",
            ].join("\n"),
            "keep_catalog",
          ),
        ],
      }),
    );
    expect(brands.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota", "Botox"]);
    expect(brands.lastHandoff?.replyText).toContain("Disport");
    expect(brands.lastHandoff?.replyText).not.toContain("faq_catalog_action");
  });

  it("opens FAQ catalog choices for consultation service names from CRM", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "консультації",
          choices: [
            { id: "svc-d", label: "Консультація дерматолога", serviceIds: ["svc-d"] },
            { id: "svc-c", label: "Консультація косметолога", serviceIds: ["svc-c"] },
          ],
        },
        agentMessages: [new AIMessage("Ось послуги напрямку.")],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([
      "Консультація дерматолога",
      "Консультація косметолога",
    ]);
  });

  it("attaches BOOKING OFFER (not catalog bullets) on «Послуги» without a trailer", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [
          new AIMessage(
            "У нашій клініці доступні такі напрями\n\n• Консультації та діагностика\n• Ін'єкційні процедури",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
  });

  it("DDD-79: booking fills Yes/Other keyboard when consultation offer omits the trailer", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        bookingNoteStatus: "unasked",
        availabilityContext: null,
        selectedSlot: null,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [
          new HumanMessage("Записатись"),
          new AIMessage(
            "Для першого візиту радимо консультацію: лікар огляне шкіру та підбере процедуру.\n\nПідібрати вільний час на консультацію?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
  });

  it("DDD-54: booking omits DEFAULT MENU for non-offer mid-flow replies without a trailer", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new HumanMessage("Записатись"),
          new AIMessage("Could you please provide your phone number?"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("prefers open FAQ catalog interaction over an accidental leftover trailer", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "напрями",
          choices: [
            { id: "g0", label: "Консультації та діагностика", serviceIds: ["a"] },
            { id: "g1", label: "Ін'єкційні процедури", serviceIds: ["b"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(
            [
              "Ось основні напрями",
              "• Консультації та діагностика",
              "• Ін'єкційні процедури",
              "",
              "Який саме напрямок вас цікавить?",
              "<reply_buttons>",
              "Ignored",
              "Labels",
              "</reply_buttons>",
            ].join("\n"),
            "keep_catalog",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([
      "Консультації та діагностика",
      "Ін'єкційні процедури",
    ]);
    expect(update.lastHandoff?.replyText).toContain("Ось основні напрями");
    expect(update.lastHandoff?.replyText).toContain("• Консультації та діагностика");
    expect(update.lastHandoff?.replyText).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
    expect(String(update.messages?.[0]?.content)).not.toContain("faq_catalog_action");
  });

  it("replaces a model catalog list with one structured list from choices", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Консультації та діагностика", serviceIds: ["a"] },
      { id: "g1", label: "Ін'єкційна косметологія", serviceIds: ["b"] },
      { id: "g2", label: "Дерматологія та видалення новоутворень", serviceIds: ["c"] },
      { id: "g3", label: "Доглядові процедури", serviceIds: ["d"] },
    ];
    const modelBody = [
      "• Консультації та діагностика",
      "• Ін'єкційна косметологія",
      "• Дерматологія та видалення новоутворень",
      "• Доглядові процедури",
      "",
      "Який варіант вам підходить?",
      "<faq_catalog_action>keep_catalog</faq_catalog_action>",
    ].join("\n");
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Обрати іншу процедуру",
          choices,
        },
        agentMessages: [new AIMessage(modelBody)],
      }),
    );

    const reply = update.lastHandoff?.replyText ?? "";
    expect(reply.startsWith("Доступні такі варіанти:")).toBe(true);
    for (const choice of choices) {
      const bullet = `• ${choice.label}`;
      expect(reply.split(bullet).length - 1).toBe(1);
    }
    expect(reply.split("Який варіант вам підходить?").length - 1).toBe(1);
    expect(update.lastHandoff?.replyButtons).toEqual(choices.map((c) => c.label));
    expect(reply).not.toContain("faq_catalog_action");
    expect(String(update.messages?.[0]?.content)).not.toContain("faq_catalog_action");
  });

  it("falls back to the catalog template when the model reply is empty", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Консультації та діагностика", serviceIds: ["a"] },
      { id: "g1", label: "Ін'єкційні процедури", serviceIds: ["b"] },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Обрати іншу процедуру",
          choices,
        },
        agentMessages: [
          faqCatalogAi("", "keep_catalog"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(
      "Доступні такі варіанти:\n\n• Консультації та діагностика\n• Ін'єкційні процедури\n\nЯкий варіант вам підходить?",
    );
    expect(update.lastHandoff?.replyButtons).toEqual(choices.map((c) => c.label));
  });

  it("offer_consultation preserves model explanation and appends one consultation question", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const explanation =
      "Для губ ми використовуємо кілька якісних препаратів — лікар під час консультації підбере той, що найкраще підійде саме вам 🌿";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("який краще?")],
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "збільшення губ",
          choices: [
            { id: "n", label: "Neotiva", serviceIds: ["n"] },
            { id: "j", label: "Juvederm", serviceIds: ["j"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(explanation, "offer_consultation"),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "service_confirm",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація" },
    });
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain(explanation);
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(
      (update.lastHandoff?.replyText ?? "")
        .split("Підібрати вільний час на консультацію?").length - 1,
    ).toBe(1);
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
  });

  it("offer_consultation after consultationDeclined keeps catalog chips", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "inj", label: "Ін'єкційна косметологія", serviceIds: ["c1", "c2"] },
      { id: "derm", label: "Дерматологія", serviceIds: ["d1"] },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("запиши на коллаген")],
        servicesContext: {
          list: [
            { id: "c1", name: "Колагеностимуляція Полімолочна кислота" },
            { id: "c2", name: "Біоревіталізація" },
            { id: "d1", name: "Видалення новоутворень" },
          ],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Обрати іншу процедуру",
          consultationDeclined: true,
          choices,
        },
        agentMessages: [
          faqCatalogAi(
            "В ін'єкційній косметології є процедура «Колагеностимуляція».",
            "offer_consultation",
          ),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_candidate");
    expect(update.lastHandoff?.replyButtons).toEqual(choices.map((c) => c.label));
    expect(update.lastHandoff?.replyText).not.toContain(
      "Підібрати вільний час на консультацію?",
    );
  });

  it("finalize prepends Запис скасовано. when REPLACE cancel continues with consultation offer", async () => {
    const finalize = createBookingFinalizeNode({
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "book",
      maxSteps: 8,
    });
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: {
        id: CONSULTATION_SERVICE_ID,
        name: "Консультація",
        source: "catalog",
      },
      accepted: false,
    });
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("✅")],
        bookingDraft: draft,
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        // No AIMessage — prepare opened the offer without an LLM turn.
        agentMessages: [new HumanMessage("✅")],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(
      "Запис скасовано.\n\nПідібрати вільний час на консультацію?",
    );
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
  });

  it("offer_consultation keeps mid-text questions and only strips a trailing yes/no", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const explanation =
      "Що таке Disport? Це препарат для ботулінотерапії; дозування підбирає лікар.";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("що таке Disport?")],
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ботулін",
          choices: [
            { id: "d", label: "Disport", serviceIds: ["d"] },
            { id: "n", label: "Nabota", serviceIds: ["n"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(
            `${explanation}\n\nПідібрати вільний час на консультацію?`,
            "offer_consultation",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain(explanation);
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(
      (update.lastHandoff?.replyText ?? "")
        .split("Підібрати вільний час на консультацію?").length - 1,
    ).toBe(1);
  });

  it("offer_consultation drops a trailing allergy question and keeps the intro prose", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const allergy = "Чи є у вас алергія на лідокаїн?";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("який краще?")],
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "губи",
          choices: [
            { id: "n", label: "Neotiva", serviceIds: ["n"] },
            { id: "j", label: "Juvederm", serviceIds: ["j"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(`Для губ є кілька препаратів.\n\n${allergy}`, "offer_consultation"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("Для губ є кілька препаратів.");
    expect(update.lastHandoff?.replyText).not.toContain(allergy);
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect((update.lastHandoff?.replyText ?? "").match(/\?/g)?.length).toBe(1);
  });

  it("close_catalog clears chips and keeps hours/location answers", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const hours = "Ми працюємо щодня з 9:00 до 20:00.";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("який у вас графік?")],
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "напрями",
          choices: [
            { id: "g0", label: "Консультації та діагностика", serviceIds: ["a"] },
          ],
        },
        agentMessages: [
          faqCatalogAi(hours, "close_catalog"),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(hours);
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("preserves product/price/comparison answers while the catalog is open", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "d", label: "Disport", serviceIds: ["d"] },
      { id: "n", label: "Nabota", serviceIds: ["n"] },
    ];
    const pending = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "ботулінотерапія",
      choices,
    };

    const product = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("що таке Disport?")],
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Disport — препарат для ботулінотерапії; дозування підбирає лікар.", "keep_catalog"),
        ],
      }),
    );
    expect(product.lastHandoff?.replyText).toContain("Disport — препарат");
    expect(product.lastHandoff?.replyText).not.toMatch(/^Доступні такі варіанти:/);
    expect(product.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota"]);
    expect(product.lastHandoff?.replyText).not.toContain("Підібрати вільний час на консультацію?");

    const price = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("скільки це коштує?")],
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Вартість залежить від препарату:\n• Disport — 4500 грн\n• Nabota — 4200 грн", "keep_catalog"),
        ],
      }),
    );
    expect(price.lastHandoff?.replyText).toContain("4500 грн");
    expect(price.lastHandoff?.replyText).not.toMatch(/^Доступні такі варіанти:/);
    expect(price.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota"]);
    expect(price.lastHandoff?.replyText).not.toContain("Підібрати вільний час на консультацію?");

    const comparison = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("яка різниця між цими препаратами?")],
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Обидва препарати з групи ботулотоксину; різниця в одиницях і підборі під зону — це вирішує лікар.", "offer_consultation"),
        ],
      }),
    );
    expect(comparison.lastHandoff?.replyText).toContain("ботулотоксину");
    expect(comparison.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
  });

  it("keeps consultation service_confirm and BOOKING_OFFER_MENU on price follow-ups", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const priceAnswer =
      "Вартість залежить від обраного препарату:\n• Neotiva — 8500 грн\n• Juvederm — 9200 грн";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("а скільки це коштує?")],
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: CONSULTATION_SERVICE_ID,
            name: "Консультація",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [new AIMessage(priceAnswer)],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(priceAnswer);
    expect(update.lastHandoff?.replyText).not.toBe(
      "Підібрати вільний час на консультацію?",
    );
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
  });

  it("keeps procedure service_confirm and BOOKING_OFFER_MENU after Скільки коштує", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const priceAnswer =
      "Вартість процедури «Лікування гіпергідрозу» — 8071 грн.\n\nБажаєте записатися на цю процедуру?";
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Скільки коштує")],
        pendingInteraction: {
          kind: "service_confirm",
          service: {
            id: "svc-hyper",
            name: "Лікування гіпергідрозу",
            source: "catalog",
          },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [new AIMessage(priceAnswer)],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(priceAnswer);
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
  });

  it("keeps catalog chips on missing or invalid faq_catalog_action via deterministic body", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const choices = [
      { id: "a", label: "Disport", serviceIds: ["a"] },
      { id: "b", label: "Nabota", serviceIds: ["b"] },
    ];
    const pending = {
      kind: "service_candidate" as const,
      owner: "faq" as const,
      utterance: "бренди",
      choices,
    };
    const expectedBody = [
      "Доступні такі варіанти:",
      "",
      "• Disport",
      "• Nabota",
      "",
      "Який варіант вам підходить?",
    ].join("\n");

    const missing = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: pending,
        agentMessages: [new AIMessage("Коротке уточнення без action-тега.")],
      }),
    );
    expect(missing.lastHandoff?.replyText).toBe(expectedBody);
    expect(missing.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota"]);
    expect(String(missing.messages?.[0]?.content)).not.toContain("faq_catalog_action");

    const invalid = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Ще раз коротко.", "invalid"),
        ],
      }),
    );
    expect(invalid.lastHandoff?.replyText).toBe(expectedBody);
    expect(invalid.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota"]);
    expect(invalid.lastHandoff?.replyText).not.toContain("faq_catalog_action");
    expect(String(invalid.messages?.[0]?.content)).not.toContain("faq_catalog_action");
  });

  it("shows displayLabel in prose while shortened label stays on the keyboard", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const longName =
      "Ботулінотерапія Botox, Disport 1 зона (очі або міжбрів'я) дуже довга назва";
    const choices = [
      {
        id: "z1",
        label: "Ботулінотерапія Botox, Disport 1 зона…",
        displayLabel: longName,
        serviceIds: ["z1"],
      },
      {
        id: "z2",
        label: "2 зони",
        serviceIds: ["z2"],
      },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "ботокс",
          choices,
        },
        agentMessages: [
          faqCatalogAi(
            "Модельна проза з іншими пунктами:\n• зовсім інше\n\nЯкий варіант?",
            "keep_catalog",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([
      "Ботулінотерапія Botox, Disport 1 зона…",
      "2 зони",
    ]);
    expect(update.lastHandoff?.replyText).toContain(longName);
    expect(update.lastHandoff?.replyText).toContain("• 2 зони");
    expect(update.lastHandoff?.replyText).not.toContain("зовсім інше");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
  });

  it("preserves FAQ service_confirm prose when the model already confirmed the procedure", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        bookingContext: makeListedMeetings(),
        pendingInteraction: {
          kind: "service_confirm",
          service: { id: "svc-peel", name: "Пілінг серединний", source: "catalog" },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
        agentMessages: [
          new AIMessage(
            "Чудово, обрано: Пілінг серединний. Бажаєте записатися на цю процедуру?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toBe(
      "Чудово, обрано: Пілінг серединний. Бажаєте записатися на цю процедуру?",
    );
  });

  it("strips an accidental catalog trailer when no FAQ catalog interaction is open", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "Який напрямок?\n<reply_buttons>\nКонсультації\nІн'єкційні процедури\n</reply_buttons>",
          ),
        ],
      }),
    );

    // Accidental trailers are stripped; chips only come from pendingInteraction.
    expect(String(update.messages?.[0]?.content)).toBe("Який напрямок?");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
    expect(unwrapCommandUpdate(update).pendingInteraction ?? null).toBeNull();
  });

});

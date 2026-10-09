import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  advanceBookingNoteStep,
  createAgentCommandPrepareNode,
  createAgentFinalizeNode,
  createAgentMutationFinalizeNode,
  createAgentPrepareNode,
  captureAvailabilityFromMessages,
  captureServicesFromMessages,
  classifyMeetingMutationToolMessage,
  createAgentToolsNode,
  crmWriteDirtiesPrefetch,
  availabilityOfferFromToolTurn,
  formatAvailabilityDateOffer,
  formatAvailabilityHeading,
  formatAvailabilityTimeOffer,
  matchAvailabilityDay,
  matchAvailabilitySlot,
  meetingMutationClearsAvailability,
  resolveAvailabilityOffer,
  routeAfterAgentPrepare,
  routeAfterAgentLlm,
  routeAfterAgentTools,
} from "../agent-loop.js";
import { setTrackEventForTests } from "../../analytics/track.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  BOOKING_NOTE_QUESTION_UK,
  BOOKING_OFFER_MENU,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_UK,
  BOOKING_REPLACE_MENU,
  CLINIC_ADDRESS,
  CONSULTATION_SERVICE_ID,
  EARLIER_DATE_LABEL,
  INTENT_SKIP_LABEL,
  LATER_DATE_LABEL,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
  PATIENT_FALLBACK_MESSAGE,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  BOOKING_SCHEDULE_RESELECT_UK,
  SERVICE_OR_NOTE_KEEP_LABEL_UK,
  SERVICE_OR_NOTE_SWITCH_LABEL_UK,
  VISIT_CHANGE_MENU,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import {
  formatAvailabilityContext,
  formatBookingMeetingsContext,
  formatContactContext,
  formatPlannedVisitsFlag,
  formatServicesContext,
  formatMyVisitReply,
  attachPrefetchVisits,
} from "../context-blocks.js";
import { createContactTools, type ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import type { ClinicState } from "../state.js";
import { createEmptyBookingDraft, reduceBookingDraft } from "../booking-draft.js";
import type { BookingDraft } from "../booking-draft.js";
import type { ClinicAgentDefinition } from "../types.js";

const listedMeetings: BookingContext = {
  meetings: [
    {
      id: "m-1",
      name: "Консультація - Daniel",
      dateStart: "2026-08-17 11:00:00",
      dateEnd: "2026-08-17 11:30:00",
    },
  ],
  dateFrom: "2026-08-11",
};

const listedContact: ContactLookupContext = {
  contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] }],
};

const ownedContactContext = (contactId = "contact-1"): ContactLookupContext => ({
  ownership: "telegram",
  contacts: [{
    id: contactId,
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    missingFields: [],
  }],
});

const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
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

const canonicalBookingDraft = (overrides: Partial<BookingDraft> = {}): BookingDraft => ({
  version: 1,
  mode: "create",
  phase: "details",
  serviceAcceptance: {
    status: "accepted",
    service: {
      id: "svc-1",
      name: "Процедура",
      source: "catalog",
    },
  },
  selectedDate: "2026-09-10",
  selectedSlot: {
    dateStart: "2026-09-10T14:00:00",
    dateEnd: "2026-09-10T14:30:00",
    label: "14:00",
  },
  requestedTime: null,
  note: { status: "skipped" },
  contactId: "contact-1",
  pendingCommand: null,
  replacement: null,
  ...overrides,
});

const createCachedGeminiModel = vi.fn(
  (_apiKey: string, _model: string, handle: { cacheName: string }) => ({
    kind: "cached",
    cacheName: handle.cacheName,
    bindTools: vi.fn(),
  }),
);

const isCachedContentNotFoundError = vi.fn((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /CachedContent not found/i.test(message);
});

vi.mock("@personal-assistant/llm-gemini", () => ({
  createCachedGeminiModel: (...args: unknown[]) =>
    (createCachedGeminiModel as (...a: unknown[]) => unknown)(...args),
  isCachedContentNotFoundError: (error: unknown) => isCachedContentNotFoundError(error),
}));

const { createAgentLlmNode } = await import("../agent-loop.js");


const faqCatalogAi = (
  content: string,
  action: "keep_catalog" | "offer_consultation" | "close_catalog" | "invalid" = "keep_catalog",
): AIMessage => {
  const tag = action === "invalid"
    ? "<faq_catalog_action>do_something_else</faq_catalog_action>"
    : `<faq_catalog_action>${action}</faq_catalog_action>`;
  const body = content.trim().length > 0 ? `${content.trim()}\n${tag}` : tag;
  return new AIMessage(body);
};

describe("formatBookingMeetingsContext", () => {
  it("returns an empty string when context is missing", () => {
    expect(formatBookingMeetingsContext(null)).toBe("");
  });

  it("renders an empty meetings list so the model does not re-fetch", () => {
    const block = formatBookingMeetingsContext({ meetings: [], dateFrom: "2026-08-11" });
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain('"meetings":[]');
    expect(block).toContain('"latestHeld":null');
    expect(block).not.toContain("When moving or cancelling");
  });

  it("wraps the list payload for uncached system metadata", () => {
    const block = formatBookingMeetingsContext(listedMeetings);
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain("</list_planned_meetings>");
    expect(block).toContain('"id":"m-1"');
    expect(block).toContain('"dateStart":"2026-08-17 11:00:00"');
    expect(block).toContain('"dateFrom":"2026-08-11"');
    expect(block).toContain('"latestHeld":null');
  });

  it("includes latestHeld without visitLabel when prefetch set a past visit", () => {
    const block = formatBookingMeetingsContext({
      ...listedMeetings,
      latestHeld: {
        id: "h-1",
        name: "Консультація - Ada Lovelace",
        dateStart: "2026-06-01 10:00:00",
        dateEnd: "2026-06-01 10:30:00",
      },
    });
    expect(block).toContain('"latestHeld":{"id":"h-1"');
    expect(block).toContain('"dateStart":"2026-06-01 10:00:00"');
    expect(block).not.toMatch(/"latestHeld":\{[^}]*"visitLabel"/);
  });

  it("adds a ready-to-quote Ukrainian visitLabel so the model does not format dates", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(formatBookingMeetingsContext(listedMeetings)).toContain(
        '"visitLabel":"Консультація - 17 серпня (понеділок) о 11:00"',
      );
      expect(formatBookingMeetingsContext(listedMeetings)).not.toContain('"whenLabel"');
      expect(formatBookingMeetingsContext(listedMeetings)).not.toContain('"serviceLabel"');
      vi.setSystemTime(new Date("2026-08-16T09:00:00Z"));
      expect(formatBookingMeetingsContext(listedMeetings)).toContain(
        '"visitLabel":"Консультація - завтра, 17 серпня (понеділок) о 11:00"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds visitLabel from CRM name (service before last ' - '), not chat", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      const block = formatBookingMeetingsContext(listedMeetings);
      expect(block).toContain(
        "When moving or cancelling, quote visitLabel from this block only — never a procedure from earlier chat.",
      );
      expect(block).toContain(
        '"visitLabel":"Консультація - 17 серпня (понеділок) о 11:00"',
      );
      expect(
        formatBookingMeetingsContext({
          dateFrom: "2026-08-11",
          meetings: [
            {
              id: "m-2",
              name: "Контурна пластика - 2 зони - Ada Lovelace",
              dateStart: "2026-08-17 11:00:00",
              dateEnd: "2026-08-17 11:30:00",
            },
          ],
        }),
      ).toContain('"visitLabel":"Контурна пластика - 2 зони - 17 серпня (понеділок) о 11:00"');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatPlannedVisitsFlag", () => {
  it("emits visits has/none under the meetings tag", () => {
    expect(formatPlannedVisitsFlag(null)).toBe(
      '<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
    expect(formatPlannedVisitsFlag({ meetings: [], dateFrom: "2026-08-11" })).toBe(
      '<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
    expect(formatPlannedVisitsFlag(listedMeetings)).toBe(
      '<list_planned_meetings>\n{"visits":"has"}\n</list_planned_meetings>',
    );
  });

  it("ignores latestHeld — visits stays none when only history exists", () => {
    expect(
      formatPlannedVisitsFlag({
        meetings: [],
        dateFrom: "2026-08-11",
        latestHeld: {
          id: "h-1",
          name: "Past",
          dateStart: "2026-06-01 10:00:00",
          dateEnd: "2026-06-01 10:30:00",
        },
      }),
    ).toBe('<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>');
  });
});

describe("attachPrefetchVisits", () => {
  it("replaces visit-ask with formatMyVisitReply", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(
        attachPrefetchVisits("stale 15:05 from chat", listedMeetings, "visit_ask"),
      ).toBe(formatMyVisitReply(listedMeetings));
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects prefetch lines on greeting even without a visit heading", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      const out = attachPrefetchVisits(
        "Привіт, Ada! Я ШІ-асистент.\n\nЧим можу допомогти?",
        listedMeetings,
        "greeting",
      );
      expect(out).toContain("🗓️ Консультація - 17 серпня (понеділок) о 11:00");
      expect(out).toContain("Чим можу допомогти?");
      expect(out.indexOf("Заплановані візити:")).toBeLessThan(out.indexOf("Чим можу допомогти?"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inject a list on other FINISH (thanks)", () => {
    const out = attachPrefetchVisits(
      "Будь ласка! Чим ще можу допомогти?",
      listedMeetings,
      "other",
    );
    expect(out).toBe("Будь ласка! Чим ще можу допомогти?");
    expect(out).not.toContain("Заплановані візити:");
  });
});

describe("formatMyVisitReply", () => {
  it("lists prefetch labels and asks to move or cancel", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      expect(formatMyVisitReply(listedMeetings)).toBe(
        "Заплановані візити:\n🗓️ Консультація - 17 серпня (понеділок) о 11:00\n\nБажаєте перенести або скасувати цей візит?",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatContactContext", () => {
  it("returns an empty string when context is missing", () => {
    expect(formatContactContext(null)).toBe("");
  });

  it("renders an empty contacts list so the model does not re-fetch", () => {
    const block = formatContactContext({ contacts: [] });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"contacts":[]');
  });

  it("renders error lookups as a completed prefetch block", () => {
    const block = formatContactContext({ contacts: [], error: "CRM down" });
    expect(block).toContain("<contact_info>");
    expect(block).toContain('"lookupFailed":true');
    expect(block).not.toContain("CRM down");
  });

  it("wraps the contact payload for uncached system metadata", () => {
    const block = formatContactContext(listedContact);
    expect(block).toContain("<contact_info>");
    expect(block).toContain("</contact_info>");
    expect(block).toContain(JSON.stringify({ contacts: listedContact.contacts }));
    expect(block).not.toContain("lookupFailed");
  });
});

describe("createAgentPrepareNode", () => {
  it("keeps original human message without synthetic ToolMessages or CRM writes", async () => {
    const prepare = createAgentPrepareNode("booking");

    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Book tomorrow")],
        stepCount: 5,
        next: "booking",
        contactContext: listedContact,
        bookingContext: listedMeetings,
      }),
    );

    expect(update.stepCount).toBe(0);
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Book tomorrow");
    expect(agentMessages.some((m) => m instanceof ToolMessage)).toBe(false);
    expect(update.contactContext).toBeUndefined();
    expect(update.bookingContext).toBeUndefined();
    expect(update.servicesContext).toBeUndefined();
  });

  it("does not clear servicesContext when preparing booking", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Book tomorrow")],
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
      }),
    );
    expect(update.servicesContext).toBeUndefined();
  });

  it("does not clear servicesContext when preparing FAQ", async () => {
    const prepare = createAgentPrepareNode("faq");
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
    const prepare = createAgentPrepareNode("faq", {
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

    expect(update.pendingInteraction?.kind).toBe("service_candidate");
    expect(update.pendingInteraction).toMatchObject({ owner: "faq" });
    expect(
      update.pendingInteraction?.kind === "service_candidate"
        ? update.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual([
      "Ін'єкційні процедури",
      "Видалення новоутворень",
    ]);
  });

  it("does not open FAQ catalog on Послуги in prepare", async () => {
    const prepare = createAgentPrepareNode("faq", {
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
    expect(update.pendingInteraction).toBeUndefined();
  });

  it("keeps Пілінг labels after a direction chip that was not that family", async () => {
    const prepare = createAgentPrepareNode("faq", {
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
      update.pendingInteraction?.kind === "service_candidate"
        ? update.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["Пілінг поверхневий", "Пілінг серединний"]);
  });

  it("strips Пілінг only after the patient chose Пілінг", async () => {
    const prepare = createAgentPrepareNode("faq", {
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
      update.pendingInteraction?.kind === "service_candidate"
        ? update.pendingInteraction.choices.map((c) => c.label)
        : [],
    ).toEqual(["поверхневий", "серединний"]);
  });

  it("leaves unmatched mid-catalog text for the FAQ model (no phrase matcher)", async () => {
    const prepare = createAgentPrepareNode("faq");
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("не знаю")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
            { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
          ],
        },
        pendingInteraction: {
          kind: "service_candidate",
          owner: "faq",
          utterance: "Botox, Disport",
          choices: [
            { id: "z1", label: "1 зона", serviceIds: ["z1"] },
            { id: "z2", label: "2 зони", serviceIds: ["z2"] },
            { id: "ff", label: "Full Face", serviceIds: ["z1", "z2"] },
          ],
        },
      }),
    );

    // Prepare only handles exact chip taps — «не знаю» reaches the model.
    expect(prepared.pendingInteraction).toBeUndefined();
  });

  it("reopens FAQ catalog chips when patient types a brand after consultation offer", async () => {
    const prepare = createAgentPrepareNode("faq", {
      partitionCandidates: async () => [
        { label: "1 зона", serviceIds: ["z1"] },
        { label: "2 зони", serviceIds: ["z2"] },
        { label: "FULL FACE", serviceIds: ["z1", "z2"] },
      ],
    });
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("botox")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона (очі або міжбрів'я)" },
            { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
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
      }),
    );

    expect(prepared.pendingInteraction?.kind).toBe("service_candidate");
    const preparedLabels =
      prepared.pendingInteraction?.kind === "service_candidate"
        ? prepared.pendingInteraction.choices.map((c) => c.label)
        : [];
    expect(preparedLabels.length).toBeGreaterThan(1);
    expect(preparedLabels).not.toEqual([...BOOKING_OFFER_MENU]);

    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("botox")],
        servicesContext: {
          list: [
            { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона (очі або міжбрів'я)" },
            { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
            { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
          ],
        },
        pendingInteraction: prepared.pendingInteraction ?? null,
        agentMessages: [
          faqCatalogAi(
            [
              "Для Botox/Disport доступні варіанти за зонами:",
              "• 1 зона (очі або міжбрів'я)",
              "• 2 зони",
              "",
              "Яка зона вас цікавить?",
            ].join("\n"),
            "keep_catalog",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual(preparedLabels);
    expect(update.lastHandoff?.replyButtons).not.toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("Який варіант вам підходить?");
    expect(update.lastHandoff?.replyText).toContain("Доступні такі варіанти:");
    expect(update.lastHandoff?.replyText).not.toContain("Підібрати вільний час на консультацію?");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
  });

  it("passes full thread history including other agents' replies", async () => {
    const prepare = createAgentPrepareNode("booking");
    const faqReply = new AIMessage({
      content: "hours are 9-18",
      additional_kwargs: { runtimeAgentId: "faq" },
    });
    const bookingReply = new AIMessage({
      content: "what day?",
      additional_kwargs: { runtimeAgentId: "booking" },
    });

    const update = await prepare(
      clinicState({
        messages: [
          new HumanMessage("hours?"),
          faqReply,
          new HumanMessage("book tomorrow"),
          bookingReply,
          new HumanMessage("10:00"),
        ],
        next: "booking",
      }),
    );

    const agentMessages = (update.agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages.map((m) => m.getType())).toEqual([
      "human",
      "ai",
      "human",
      "ai",
      "human",
    ]);
    expect((agentMessages[0] as HumanMessage).content).toBe("hours?");
    expect((agentMessages[4] as HumanMessage).content).toBe("10:00");
  });

  it("does not repair a malformed draft from consultation prose", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [
          new HumanMessage("Консультація"),
          new AIMessage("Бажаєте записатися на консультацію?"),
          new HumanMessage("Так"),
        ],
        bookingNoteStatus: "answered",
        selectedAvailabilityDate: "2026-10-16",
        selectedSlot: {
          dateStart: "2026-10-16T11:00:00",
          dateEnd: "2026-10-16T11:30:00",
          label: "11:00",
        },
        bookingDraft: {
          ...canonicalBookingDraft({
            version: 8,
            phase: "note",
            serviceAcceptance: null,
            selectedDate: "2026-10-16",
            selectedSlot: {
              dateStart: "2026-10-16T11:00:00",
              dateEnd: "2026-10-16T11:30:00",
              label: "11:00",
            },
            note: { status: "answered", value: "біль" },
            contactId: null,
          }),
          serviceAcceptance: null,
        } as never,
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "contact-1", firstName: "Ada" }],
        },
      }),
    );

    expect(update.bookingDraft?.serviceAcceptance).toBeNull();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.selectedAvailabilityDate).toBeUndefined();
  });

  it("folds a date after a pending consultation offer into the draft", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [
          new AIMessage("Бажаєте записатися на консультацію?"),
          new HumanMessage("2026-10-16"),
        ],
        bookingDraft: {
          ...canonicalBookingDraft({
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
        },
      }),
    );

    expect(update.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(update.bookingDraft?.selectedDate).toBe("2026-10-16");
    expect(update.bookingDraft?.selectedSlot).toBeNull();
    expect(update.bookingDraft?.phase).toBe("time");
  });

  it.each([
    "потрібна консультація щодо ювідерм",
    "потрібна консультація щодо збільшення губ",
  ])(
    "does not rewrite Juvederm to Consultation when note orch owns: %s",
    async (patientText) => {
      const prepare = createAgentPrepareNode("booking");
      const juvedermDraft = canonicalBookingDraft({
        phase: "note",
        serviceAcceptance: {
          status: "accepted",
          service: {
            id: "svc-juvederm",
            name: "Juvederm",
            source: "catalog",
          },
        },
        selectedDate: "2026-10-19",
        selectedSlot: {
          dateStart: "2026-10-19T12:00:00",
          dateEnd: "2026-10-19T12:30:00",
          label: "12:00",
        },
        note: { status: "awaiting" },
        contactId: null,
      });
      const update = await prepare(
        clinicState({
          messages: [new HumanMessage(patientText)],
          bookingDraft: juvedermDraft,
          pendingInteraction: {
            kind: "visit_note",
            choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
          },
        }),
      );

      expect(update.noteOrchQueued).toBe(true);
      expect(update.bookingDraft?.serviceAcceptance?.service.id).toBe("svc-juvederm");
      expect(update.bookingDraft?.serviceAcceptance?.service.name).toBe("Juvederm");
      expect(update.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-19T12:00:00");
      expect(update.bookingDraft?.note.status).toBe("awaiting");
      expect(update.pendingInteraction).toBeUndefined();
    },
  );

  it("applies a date onto a supervisor-seeded reschedule draft", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [
          new AIMessage("Заплановані візити: консультація — 16 жовтня о 13:00"),
          new HumanMessage("23 жовтня"),
        ],
        bookingDraft: {
          ...createEmptyBookingDraft(),
          mode: "reschedule",
          phase: "date",
          rescheduleTarget: {
            id: "meeting-1",
            name: "Консультація",
            dateStart: "2026-10-16 13:00:00",
            dateEnd: "2026-10-16 13:30:00",
          },
        },
        bookingContext: {
          meetings: [
            {
              id: "meeting-1",
              name: "Консультація",
              dateStart: "2026-10-16 13:00:00",
              dateEnd: "2026-10-16 13:30:00",
            },
          ],
          dateFrom: "2026-10-02",
        },
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      mode: "reschedule",
      phase: "time",
      selectedDate: "2026-10-23",
      rescheduleTarget: { id: "meeting-1" },
    });
  });

  it("opens a fresh session from an empty draft on the same turn", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [
          new AIMessage("Бажаєте записатися на консультацію?"),
          new HumanMessage("хочу консультацію"),
        ],
        bookingDraft: {
          ...createEmptyBookingDraft(),
          version: 4,
          contactId: "stale-contact",
        },
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      mode: "create",
      serviceAcceptance: {
        status: "accepted",
        service: { id: CONSULTATION_SERVICE_ID },
      },
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
      pendingCommand: null,
      replacement: null,
    });
    expect(update.bookingDraft?.contactId).not.toBe("stale-contact");
  });

  it("leaves a malformed draft untouched when the turn does not open a session", async () => {
    const prepare = createAgentPrepareNode("booking");
    const malformed = {
      ...createEmptyBookingDraft(),
      version: 6,
      selectedDate: "2026-10-16",
      selectedSlot: {
        dateStart: "2026-10-16T11:00:00",
        dateEnd: "2026-10-16T11:30:00",
        label: "11:00",
      },
      note: { status: "answered" as const, value: "біль" },
      serviceAcceptance: null,
    };
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("скільки коштує ботокс?")],
        bookingDraft: malformed,
        bookingNoteStatus: "answered",
        selectedSlot: malformed.selectedSlot,
        selectedAvailabilityDate: "2026-10-16",
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      version: 6,
      serviceAcceptance: null,
      selectedDate: "2026-10-16",
      note: { status: "answered", value: "біль" },
    });
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.selectedAvailabilityDate).toBeUndefined();
  });

  it("opens a fresh session after a malformed draft on the same turn", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("хочу консультацію")],
        bookingDraft: {
          ...createEmptyBookingDraft(),
          version: 6,
          selectedDate: "2026-10-16",
          selectedSlot: {
            dateStart: "2026-10-16T11:00:00",
            dateEnd: "2026-10-16T11:30:00",
            label: "11:00",
          },
          note: { status: "answered", value: "біль" },
          serviceAcceptance: null,
        },
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      mode: "create",
      serviceAcceptance: {
        status: "accepted",
        service: { id: CONSULTATION_SERVICE_ID },
      },
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
    });
  });
});

describe("booking session mutation lifecycle", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  const mutationMessages = (
    name: "create_meeting" | "reschedule_meeting" | "cancel_meeting",
    content: unknown,
  ): [AIMessage, ToolMessage] => [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "mut-1", name, args: {}, type: "tool_call" }],
    }),
    new ToolMessage({
      content: JSON.stringify(content),
      tool_call_id: "mut-1",
      name,
    }),
  ];

  it("closes create and reschedule sessions on committed or declined outcomes", () => {
    const finalize = createAgentMutationFinalizeNode(agent);
    for (const [name, content] of [
      ["create_meeting", { id: "m-1", success: true }],
      ["create_meeting", { cancelled: true }],
      ["reschedule_meeting", { id: "m-1", success: true }],
      ["reschedule_meeting", { cancelled: true }],
    ] as const) {
      const update = finalize(clinicState({
        bookingDraft: canonicalBookingDraft(),
        agentMessages: mutationMessages(name, content),
      }));
      expect(update.bookingDraft).toBeNull();
    }
  });

  it("keeps recoverable create progress after a failed mutation", async () => {
    const createTool = tool(
      async () => JSON.stringify({ error: "CRM unavailable" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "s1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        availabilityContext: availability,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(toolsUpdate.bookingDraft).toMatchObject({
      serviceAcceptance: { status: "accepted", service: { id: "svc-1" } },
      note: { status: "skipped" },
      contactId: "contact-1",
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("closes direct cancel on failed or blocked outcomes", () => {
    const finalize = createAgentMutationFinalizeNode(agent);
    for (const content of [
      { error: "CRM unavailable" },
      { error: "Contact incomplete" },
    ]) {
      const update = finalize(clinicState({
        bookingDraft: {
          ...createEmptyBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "m-1" },
          },
        },
        pendingCancellationPurpose: "direct",
        agentMessages: mutationMessages("cancel_meeting", content),
      }));
      expect(update.bookingDraft).toBeNull();
    }
  });

  it("closes replacement cancel failures without replaying originalCommand", () => {
    const finalize = createAgentMutationFinalizeNode(agent);
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: "svc-1",
        contactId: "contact-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    };
    const update = finalize(clinicState({
      bookingDraft: canonicalBookingDraft({
        mode: "replace",
        phase: "confirming",
        pendingCommand: {
          action: "cancel",
          payload: { meetingId: "existing-1" },
        },
        replacement: {
          meeting: { id: "existing-1" },
          status: "cancelling",
          originalCommand,
        },
      }),
      pendingCancellationPurpose: "replacement",
      agentMessages: mutationMessages("cancel_meeting", { error: "CRM unavailable" }),
    }));

    expect(update.bookingDraft).toBeNull();
    expect(update.pendingCancellationPurpose).toBeNull();
  });

  it("ends HITL create decline at null even when tools invalidated the slot first", async () => {
    const createTool = tool(
      async () => JSON.stringify({ cancelled: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "s1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        availabilityContext: availability,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(toolsUpdate.bookingDraft?.selectedSlot).toBeNull();
    expect(toolsUpdate.bookingDraft?.serviceAcceptance?.status).toBe("accepted");

    const finalUpdate = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
        }),
        (toolsUpdate.agentMessages as ToolMessage[])[0]!,
      ],
    }));
    expect(finalUpdate.bookingDraft).toBeNull();
  });

  it("ignores main-menu text while advancing the note step", () => {
    expect(advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage(MAIN_MENU_LABEL)],
      bookingDraft: canonicalBookingDraft({
        note: { status: "awaiting" },
      }),
    }))).toEqual({});
  });
});

describe("crmWriteDirtiesPrefetch", () => {
  it("is true for a successful CRM write tool result", () => {
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ id: "c-1" }),
          tool_call_id: "1",
          name: "create_contact",
        }),
      ]),
    ).toBe(true);
  });

  it("is false for HITL pending, errors, and read tools", () => {
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ cancelled: true }),
          tool_call_id: "1",
          name: "cancel_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          tool_call_id: "1",
          name: "update_contact",
        }),
      ]),
    ).toBe(false);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ error: "Not authorized" }),
          tool_call_id: "1",
          name: "cancel_meeting",
        }),
      ]),
    ).toBe(true);
    expect(
      crmWriteDirtiesPrefetch([
        new ToolMessage({
          content: JSON.stringify({ slots: [] }),
          tool_call_id: "1",
          name: "present_availability_slots",
        }),
      ]),
    ).toBe(false);
  });
});

describe("availability context helpers", () => {
  const sampleAvailability = {
    days: [
      {
        date: "2026-08-25",
        dayLabel: "25 серпня (вівторок)",
        slots: [
          {
            id: "s1",
            label: "11:00",
            dateStart: "2026-08-25T11:00:00",
            dateEnd: "2026-08-25T11:30:00",
          },
        ],
      },
    ],
    stepMinutes: 30,
  };

  it("classifies meeting mutation outcomes", () => {
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ id: "m-new" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("committed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("failed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "Contact incomplete" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("blocked");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "Note step required" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("blocked");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("pending_confirmation");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({ content: "", tool_call_id: "1", name: "create_meeting" }),
      ),
    ).toBe("failed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({ content: "not json", tool_call_id: "1", name: "create_meeting" }),
      ),
    ).toBe("failed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ ok: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("failed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ success: true }),
          tool_call_id: "1",
          name: "cancel_meeting",
        }),
      ),
    ).toBe("failed");
  });

  it("clears availability on committed, failed, or HITL decline", () => {
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ id: "m-new" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(true);
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ error: "Slot taken" }),
          tool_call_id: "1",
          name: "reschedule_meeting",
        }),
      ]),
    ).toBe(true);
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ cancelled: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(true);
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ error: "Contact incomplete" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ]),
    ).toBe(false);
    expect(
      meetingMutationClearsAvailability([
        new ToolMessage({
          content: JSON.stringify({ id: "c-1" }),
          tool_call_id: "1",
          name: "update_contact",
        }),
      ]),
    ).toBe(false);
  });

  it("captures present_availability_slots from tool messages", () => {
    expect(
      captureAvailabilityFromMessages([
        new ToolMessage({
          content: JSON.stringify({
            days: sampleAvailability.days,
            stepMinutes: 30,
            excludeMeetingIds: ["m-1"],
          }),
          tool_call_id: "1",
          name: "present_availability_slots",
        }),
      ]),
    ).toEqual({
      days: sampleAvailability.days,
      stepMinutes: 30,
      excludeMeetingIds: ["m-1"],
    });
  });

  it("formatAvailabilityContext wraps JSON in availability tags", () => {
    const block = formatAvailabilityContext(sampleAvailability);
    expect(block).toContain("<availability>");
    expect(block).toContain("2026-08-25T11:00:00");
  });
});

describe("services context helpers", () => {
  const sampleServices = {
    list: [
      { id: "svc-1", name: "Консультація", duration: 30 },
      { id: "svc-2", name: "Біоревіталізація", duration: 60, description: "Neuvia" },
    ],
    total: 2,
  };

  it("captures list_services payloads that contain JSON-escaped newlines", () => {
    const payload = {
      list: [
        {
          id: "svc-1",
          name: "Пілінг",
          duration: 60,
          description: "Line 1\nLine 2",
        },
      ],
      total: 1,
    };
    const raw = JSON.stringify(payload);
    expect(() => JSON.parse(extractMessageTextContent(raw))).toThrow();
    expect(
      captureServicesFromMessages([
        new ToolMessage({
          content: raw,
          tool_call_id: "1",
          name: "list_services",
        }),
      ]),
    ).toEqual(payload);
  });

  it("captures list_services from tool messages", () => {
    expect(
      captureServicesFromMessages([
        new ToolMessage({
          content: JSON.stringify(sampleServices),
          tool_call_id: "1",
          name: "list_services",
        }),
      ]),
    ).toEqual(sampleServices);
  });

  it("returns undefined for list_services error payloads", () => {
    expect(
      captureServicesFromMessages([
        new ToolMessage({
          content: JSON.stringify({ error: "CRM down" }),
          tool_call_id: "1",
          name: "list_services",
        }),
      ]),
    ).toBeUndefined();
  });

  it("formatServicesContext wraps JSON in list_services tags", () => {
    const block = formatServicesContext(sampleServices);
    expect(block).toContain("<list_services>");
    expect(block).toContain("svc-1");
  });
});

describe("createAgentToolsNode services capture", () => {
  it("captures servicesContext from list_services on FAQ", async () => {
    const listTool = tool(
      async () =>
        JSON.stringify({
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
          total: 1,
        }),
      {
        name: "list_services",
        description: "List services",
        schema: z.object({}),
      },
    );

    const toolsNode = createAgentToolsNode([listTool], "faq");
    const update = await toolsNode(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "list_services", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.servicesContext).toEqual({
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    });
  });

  it("captures servicesContext from list_services on booking", async () => {
    const listTool = tool(
      async () =>
        JSON.stringify({
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
          total: 1,
        }),
      {
        name: "list_services",
        description: "List services",
        schema: z.object({}),
      },
    );

    const toolsNode = createAgentToolsNode([listTool], "booking");
    const update = await toolsNode(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "list_services", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.servicesContext).toEqual({
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    });
  });

  it("does not clear servicesContext on update_contact", async () => {
    const updateTool = tool(async () => JSON.stringify({ id: "c-1" }), {
      name: "update_contact",
      description: "Update contact",
      schema: z.object({ firstName: z.string().optional() }),
    });

    const toolsNode = createAgentToolsNode([updateTool], "faq");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "1", name: "update_contact", args: { firstName: "Ada" }, type: "tool_call" },
            ],
          }),
        ],
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
      }),
      { configurable: {} },
    );

    expect(update.servicesContext).toBeUndefined();
  });
});

describe("createAgentToolsNode contact capture (DDD-86)", () => {
  it("sets contactContext from find_contact_by_phone hit", async () => {
    const findTool = tool(
      async () =>
        JSON.stringify({
          contacts: [
            {
              id: "c-phone",
              firstName: "Ada",
              lastName: "Lovelace",
              phoneNumber: "+380682667818",
              cTelegram: null,
            },
          ],
        }),
      {
        name: "find_contact_by_phone",
        description: "Find by phone",
        schema: z.object({ phoneNumber: z.string() }),
      },
    );

    const toolsNode = createAgentToolsNode([findTool], "booking");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("+380682667818")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380682667818" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toEqual({
      ownership: "phone",
      contacts: [
        {
          id: "c-phone",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380682667818",
          cTelegram: null,
          missingFields: [],
        },
      ],
    });
    expect(update.prefetchDirty).toBeUndefined();
  });

  it("does not promote a phone match to Telegram ownership", async () => {
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            firstName: "Ada",
            cTelegram: null,
          }],
        },
      }),
    );

    expect(update.bookingDraft?.contactId).toBeNull();
  });

  it("does not prepare a runtime booking command from a phone candidate", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "slot-1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
    };
    const update = await commandPrepare(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        availabilityContext: availability,
        agentMessages: [new ToolMessage({
          content: JSON.stringify(availability),
          name: "present_availability_slots",
          tool_call_id: "slots-1",
        })],
      }),
    );

    expect(update.bookingDraft).toBeUndefined();
    expect(update.agentMessages).toBeUndefined();
  });

  it("does not trust a draft contact id without Telegram ownership evidence", async () => {
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "slot-1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
    };
    const update = await createAgentCommandPrepareNode("booking")(
      clinicState({
        contactContext: null,
        bookingDraft: canonicalBookingDraft({ contactId: "unverified-contact" }),
        availabilityContext: availability,
        agentMessages: [new ToolMessage({
          content: JSON.stringify(availability),
          name: "present_availability_slots",
          tool_call_id: "slots-1",
        })],
      }),
    );

    expect(update.bookingDraft).toBeUndefined();
    expect(update.agentMessages).toBeUndefined();
  });

  it("blocks a model-supplied contact id when ownership context is missing", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({ contactId: z.string().optional() }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: null,
        bookingDraft: canonicalBookingDraft({ contactId: "unverified-contact" }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-1",
            name: "create_meeting",
            args: { contactId: "unverified-contact" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      error: "Contact ownership required",
    });
  });

  it("marks a successfully linked phone match as Telegram-owned", async () => {
    const linkTool = tool(async () => JSON.stringify({ success: true, id: "c-phone" }), {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([linkTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "link-1",
            name: "link_telegram_to_contact",
            args: { contactId: "c-phone" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-phone" }],
    });
    expect(update.bookingDraft).toMatchObject({ contactId: "c-phone" });
  });

  it.each([
    {
      label: "contact outside the phone search",
      contactId: "c-other",
      contacts: [{ id: "c-phone", cTelegram: null }],
    },
    {
      label: "contact linked to another Telegram user",
      contactId: "c-phone",
      contacts: [{ id: "c-phone", cTelegram: "tg-other" }],
    },
  ])("does not link an unsafe phone candidate: $label", async ({ contactId, contacts }) => {
    const invoke = vi.fn(async () => JSON.stringify({ id: contactId }));
    const linkTool = tool(invoke, {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([linkTool], "booking")(
      clinicState({
        contactContext: { ownership: "phone", contacts },
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "unsafe-link-1",
            name: "link_telegram_to_contact",
            args: { contactId },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      error: "Contact link candidate required",
    });
  });

  it("does not create_contact when phone matches a stored occupied candidate", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_contact",
      description: "create",
      schema: z.object({
        firstName: z.string(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        messages: [
          new HumanMessage("+380632123123"),
          new HumanMessage("Артем"),
          new HumanMessage("Тест"),
        ],
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-occupied-1",
            name: "create_contact",
            args: {
              firstName: "Артем",
              lastName: "Тест",
              phoneNumber: "+380 63 212 3123",
            },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      error: "Contact link candidate required",
    });
  });

  it("still creates a contact when the phone differs from the occupied candidate", async () => {
    const invoke = vi.fn(async () => JSON.stringify({
      success: true,
      id: "c-new",
      firstName: "Артем",
      phoneNumber: "+380502838425",
    }));
    const createTool = tool(invoke, {
      name: "create_contact",
      description: "create",
      schema: z.object({
        firstName: z.string(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        messages: [
          new HumanMessage("+380632123123"),
          new HumanMessage("+380502838425"),
          new HumanMessage("Артем"),
          new HumanMessage("Тест"),
        ],
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-other-1",
            name: "create_contact",
            args: {
              firstName: "Артем",
              lastName: "Тест",
              phoneNumber: "+380 50 283 8425",
            },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-new" }],
    });
  });

  it("keeps an incomplete linked contact in the model path until details are updated", () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-phone",
          firstName: "Ada",
          lastName: null,
          phoneNumber: "+380501112233",
          missingFields: ["lastName"],
        }],
      },
      bookingDraft: canonicalBookingDraft({ contactId: "c-phone" }),
      availabilityContext: {
        days: [{
          date: "2026-09-10",
          slots: [{
            id: "slot-1",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          }],
        }],
        stepMinutes: 30,
      },
    });

    expect(routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"))
      .toBe("booking__llm");
  });

  it("updates the checkpointed missing-field projection from the production update response", async () => {
    const updateTool = createContactTools({
      callTool: async (_name, args) =>
        `Successfully updated Contact record with ID: ${String(args?.entityId ?? "")}`,
    }).find((candidate) => candidate.name === "update_contact")!;
    const update = await createAgentToolsNode([updateTool], "booking")(
      clinicState({
        messages: [new HumanMessage("Ada Lovelace")],
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-phone",
            firstName: "Ada",
            lastName: null,
            phoneNumber: "+380501112233",
            missingFields: ["lastName"],
          }],
        },
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "update-1",
            name: "update_contact",
            args: { contactId: "c-phone", lastName: "Lovelace" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-phone", lastName: "Lovelace", missingFields: [] }],
    });
  });

  it("clears a create command after CRM authorization failure", async () => {
    const createTool = tool(async () => JSON.stringify({ error: "Not authorized" }), {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: "tg-1" }],
        },
        bookingDraft: canonicalBookingDraft({
          contactId: "c-phone",
          phase: "confirming",
          pendingCommand: { action: "create", payload: { contactId: "c-phone" } },
        }),
        availabilityContext: {
          days: [{
            date: "2026-09-10",
            slots: [{
              id: "slot-1",
              label: "14:00",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            }],
          }],
          stepMinutes: 30,
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: [{
                date: "2026-09-10",
                slots: [{
                  id: "slot-1",
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
              }],
              stepMinutes: 30,
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "create-1",
              name: "create_meeting",
              args: { contactId: "c-phone" },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.bookingDraft).toMatchObject({
      contactId: null,
      pendingCommand: null,
    });
    expect(update.contactContext).toBeNull();
    expect(update.bookingContext).toBeNull();
    expect(update.prefetchDirty).toBe(true);
    expect(routeAfterAgentTools(
      clinicState({ ...clinicState(), ...update }),
      "llm",
      "tools",
      "mutation-finalize",
      "command-prepare",
    )).toBe("llm");
  });

  it("does not call create_meeting for a phone candidate before linking", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "slot-1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
    };
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({
          contactId: "c-phone",
          phase: "confirming",
          pendingCommand: { action: "create", payload: { contactId: "c-phone" } },
        }),
        availabilityContext: availability,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify(availability),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "create-1",
              name: "create_meeting",
              args: { contactId: "c-phone" },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      error: "Contact ownership required",
    });
  });

  it("does not set contactContext on empty or error find", async () => {
    for (const payload of [
      { contacts: [] },
      { error: "CRM down" },
    ]) {
      const findTool = tool(async () => JSON.stringify(payload), {
        name: "find_contact_by_phone",
        description: "Find by phone",
        schema: z.object({ phoneNumber: z.string() }),
      });

      const toolsNode = createAgentToolsNode([findTool], "booking");
      const update = await toolsNode(
        clinicState({
          messages: [new HumanMessage("+380682667818")],
          contactContext: listedContact,
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "1",
                  name: "find_contact_by_phone",
                  args: { phoneNumber: "+380682667818" },
                  type: "tool_call",
                },
              ],
            }),
          ],
        }),
        { configurable: {} },
      );

      expect(update.contactContext).toBeUndefined();
    }
  });
});

describe("createAgentLlmNode context cache", () => {
  const sampleTool = tool(async () => "ok", {
    name: "list_services",
    description: "List services",
    schema: z.object({}),
  });

  const faqAgent: ClinicAgentDefinition = {
    id: "faq",
    name: "FAQ",
    description: "FAQ",
    systemPrompt: "STATIC FAQ PROMPT",
    maxSteps: 4,
  };

  const invoke = vi.fn();
  const bindTools = vi.fn(() => ({ invoke }));
  const cachedInvoke = vi.fn();

  const model = { bindTools } as unknown as BaseChatModel;

  beforeEach(() => {
    invoke.mockReset();
    bindTools.mockClear();
    cachedInvoke.mockReset();
    createCachedGeminiModel.mockReset();
    isCachedContentNotFoundError.mockClear();
    createCachedGeminiModel.mockImplementation(
      (_apiKey: string, _model: string, handle: { cacheName: string }) => ({
        kind: "cached",
        cacheName: handle.cacheName,
        bindTools: vi.fn(),
        invoke: cachedInvoke,
      }),
    );
    invoke.mockResolvedValue(new AIMessage("uncached reply"));
    cachedInvoke.mockResolvedValue(new AIMessage("cached reply"));
  });

  it("uses SystemMessage with static prompt when cache misses", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => null),
      invalidate: vi.fn(),
    };

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC METADATA",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

    expect(createCachedGeminiModel).not.toHaveBeenCalled();
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "gemini-2.5-flash",
        staticSystemInstruction: "STATIC FAQ PROMPT",
        tools: [sampleTool],
        displayName: "clinic-faq",
      }),
    );
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC FAQ PROMPT");
    expect((messages[0] as SystemMessage).content).toContain("DYNAMIC METADATA");
    const agentMessages = update.agentMessages as AIMessage[];
    expect(agentMessages[0]).toBeInstanceOf(AIMessage);
    expect(agentMessages[0].content).toBe("uncached reply");
  });

  it("uses HumanMessage for dynamic context on cache hit (not SystemMessage)", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

    expect(createCachedGeminiModel).toHaveBeenCalledOnce();
    expect(bindTools).toHaveBeenCalledTimes(1);
    const messages = cachedInvoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect((messages[0] as HumanMessage).content).toBe(
      'DYNAMIC KYIV\n\n<list_planned_meetings>\n{"visits":"none"}\n</list_planned_meetings>',
    );
    expect(messages.some((m) => m instanceof SystemMessage)).toBe(false);
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "clinic-faq",
        tools: [sampleTool],
      }),
    );
  });

  it("appends contact and listed meetings to booking dynamic context only", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const faqNode = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });
    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await faqNode(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        bookingContext: listedMeetings,
        contactContext: listedContact,
        next: "faq",
      }),
    );
    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("скасуй")],
        bookingContext: listedMeetings,
        contactContext: listedContact,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    const bookingDynamic = (cachedInvoke.mock.calls[1]?.[0] as unknown[])[0] as HumanMessage;
    expect(faqDynamic.content).toContain("DYNAMIC KYIV");
    expect(String(faqDynamic.content)).toContain(formatPlannedVisitsFlag(listedMeetings));
    expect(String(faqDynamic.content)).not.toContain("<contact_info>");
    expect(String(faqDynamic.content)).not.toContain('"visitLabel"');
    expect(String(faqDynamic.content)).not.toContain('"meetings"');
    expect(String(faqDynamic.content)).not.toContain("<availability>");
    expect(String(faqDynamic.content)).not.toContain("<list_services>");
    expect(bookingDynamic.content).toContain("DYNAMIC KYIV");
    expect(bookingDynamic.content).toContain(formatContactContext(listedContact));
    expect(bookingDynamic.content).toContain(formatBookingMeetingsContext(listedMeetings));
    // Full days[] is not injected into the LLM prompt (served via slots tool / cache).
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
    expect(String(bookingDynamic.content)).not.toContain('"visits"');
  });

  it("appends list_services to FAQ and booking when catalog is set and availability is empty", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    };

    const faqNode = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });
    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await faqNode(
      clinicState({
        agentMessages: [new HumanMessage("Послуги")],
        servicesContext: sampleServices,
        next: "faq",
      }),
    );
    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("Записатись")],
        servicesContext: sampleServices,
        next: "booking",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    const bookingDynamic = (cachedInvoke.mock.calls[1]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).toContain("<list_services>");
    expect(String(faqDynamic.content)).toContain("svc-1");
    expect(String(bookingDynamic.content)).toContain("<list_services>");
    expect(String(bookingDynamic.content)).toContain("svc-1");
  });

  it("keeps list_services on booking when availabilityContext has days", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    };

    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await bookingNode(
      clinicState({
        agentMessages: [new HumanMessage("4 вересня")],
        servicesContext: sampleServices,
        availabilityContext: {
          days: [{ date: "2026-09-04", slots: [{ label: "11:00", dateStart: "2026-09-04T11:00:00", dateEnd: "2026-09-04T11:30:00" }] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).toContain("<list_services>");
  });

  it("still appends list_services to FAQ when availabilityContext is set", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const sampleServices = {
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    };

    const faqNode = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await faqNode(
      clinicState({
        agentMessages: [new HumanMessage("Послуги")],
        servicesContext: sampleServices,
        availabilityContext: {
          days: [{ date: "2026-09-04", slots: [] }],
          stepMinutes: 30,
        },
        next: "faq",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).toContain("<list_services>");
  });

  it("omits list_services block when list_services already ran this turn", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const faqNode = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await faqNode(
      clinicState({
        agentMessages: [
          new HumanMessage("Послуги"),
          new ToolMessage({
            content: JSON.stringify({ list: [{ id: "svc-1", name: "Консультація" }] }),
            tool_call_id: "1",
            name: "list_services",
          }),
        ],
        stepCount: 1,
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
        next: "faq",
      }),
    );

    const faqDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(faqDynamic.content)).not.toContain("<list_services>");
  });

  it("omits full availability from booking LLM even when a different tool ran this turn", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await bookingNode(
      clinicState({
        agentMessages: [
          new HumanMessage("Записатись"),
          new ToolMessage({
            content: JSON.stringify({ list: [{ id: "svc-1", name: "Консультація" }] }),
            tool_call_id: "1",
            name: "list_services",
          }),
        ],
        stepCount: 1,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        servicesContext: {
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
  });

  it("omits availability block when present_availability_slots already ran this turn", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const bookingNode = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYNAMIC KYIV",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await bookingNode(
      clinicState({
        agentMessages: [
          new HumanMessage("book"),
          new ToolMessage({
            content: JSON.stringify({ days: [] }),
            tool_call_id: "1",
            name: "present_availability_slots",
          }),
        ],
        stepCount: 1,
        availabilityContext: {
          days: [{ date: "2026-08-25", slots: [] }],
          stepMinutes: 30,
        },
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<availability>");
  });

  it("invalidates and retries once on CachedContent not found", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash",
        })
        .mockResolvedValueOnce({
          cacheName: "caches/fresh",
          model: "models/gemini-2.5-flash",
        }),
      invalidate: vi.fn(),
    };

    cachedInvoke
      .mockRejectedValueOnce(new Error("CachedContent not found"))
      .mockResolvedValueOnce(new AIMessage("recovered"));

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect((update.agentMessages as AIMessage[])[0].content).toBe("recovered");
  });

  it("falls back to uncached when recreate returns null", async () => {
    const manager = {
      getOrCreate: vi
        .fn()
        .mockResolvedValueOnce({
          cacheName: "caches/stale",
          model: "models/gemini-2.5-flash",
        })
        .mockResolvedValueOnce(null),
      invalidate: vi.fn(),
    };

    cachedInvoke.mockRejectedValueOnce(new Error("CachedContent not found"));
    invoke.mockResolvedValueOnce(new AIMessage("uncached after miss"));

    const node = createAgentLlmNode({
      agent: faqAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "faq",
      }),
    );

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(createCachedGeminiModel).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC FAQ PROMPT");
    expect((messages[0] as SystemMessage).content).toContain("DYN");
    expect((update.agentMessages as AIMessage[])[0].content).toBe("uncached after miss");
  });

  it("uses clinic-booking displayName for booking agent", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => null),
      invalidate: vi.fn(),
    };

    const bookingAgent: ClinicAgentDefinition = {
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "STATIC BOOKING",
      maxSteps: 10,
    };

    const node = createAgentLlmNode({
      agent: bookingAgent,
      model,
      tools: [sampleTool],
      formatSystemMetadata: () => "DYN",
      contextCache: {
        manager,
        apiKey: "key",
        modelName: "gemini-2.5-flash",
      },
    });

    await node(
      clinicState({
        agentMessages: [new HumanMessage("book")],
        next: "booking",
      }),
    );

    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "clinic-booking" }),
    );
  });
});

describe("routeAfterAgentLlm", () => {
  it("routes a direct cancellation to runtime command preparation even after plain model text", () => {
    expect(
      routeAfterAgentLlm(
        clinicState({
          messages: [new HumanMessage("Скасувати")],
          bookingContext: listedMeetings,
          bookingDraft: {
            ...createEmptyBookingDraft(),
            pendingCommand: {
              action: "cancel",
              payload: { meetingId: "m-1", confirmMessage: "Скасувати цей візит?" },
            },
          },
          agentMessages: [new AIMessage("Запис скасовано")],
          stepCount: 1,
        }),
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("routes a ready draft to runtime command preparation before the step limit", () => {
    expect(
      routeAfterAgentLlm(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft(),
          agentMessages: [new AIMessage("Готово! Запис створено.")],
          stepCount: 5,
        }),
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });
});

describe("runtime-owned booking routing", () => {
  it("bypasses the LLM when prepare has a complete booking draft", () => {
    expect(
      routeAfterAgentPrepare(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft(),
        }),
        "booking__llm",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("uses the LLM while canonical booking facts are still missing", () => {
    expect(
      routeAfterAgentPrepare(
        clinicState({
          bookingDraft: canonicalBookingDraft({
            phase: "note",
            note: { status: "awaiting" },
          }),
        }),
        "booking__llm",
        "booking__command_prepare",
      ),
    ).toBe("booking__llm");
  });

  it("routes a checkpointed bare-day selection to availability before the LLM", async () => {
    const state = clinicState({
      messages: [new HumanMessage("26")],
      agentMessages: [new HumanMessage("26")],
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2099-10-26",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
      availabilityContext: {
        days: [{ date: "2099-10-25", slots: [] }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2099-10-25",
          rangeFrom: "2099-10-25",
          rangeThrough: "2099-10-25",
          coverageComplete: true,
        },
      },
    });
    expect(
      routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"),
    ).toBe("booking__command_prepare");

    const update = await createAgentCommandPrepareNode("booking")(state);
    const prepared = (update.agentMessages as Overwrite<AIMessage[]>).value;
    const call = prepared.at(-1)?.tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: { direction: "exact", date: "2099-10-26" },
    });
  });

  it("requests nearest availability for a service-change notice with the new duration", async () => {
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const state = clinicState({
      messages: [new HumanMessage("Neotiva")],
      agentMessages: [new HumanMessage("Neotiva")],
      serviceChangeNotice: notice,
      bookingDraft: canonicalBookingDraft({
        phase: "date",
        selectedDate: null,
        selectedSlot: null,
        note: { status: "answered", value: "запиши на збільшення губ" },
        serviceAcceptance: {
          status: "accepted",
          service: {
            id: "svc-neotiva",
            name: "Збільшення губ Neotiva",
            durationMinutes: 60,
            source: "catalog",
          },
        },
      }),
      availabilityContext: null,
    });
    expect(
      routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"),
    ).toBe("booking__command_prepare");

    const update = await createAgentCommandPrepareNode("booking")(state);
    const prepared = (update.agentMessages as Overwrite<AIMessage[]>).value;
    const call = prepared.at(-1)?.tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "nearest",
        forceRefresh: true,
        durationMinutes: 60,
      },
    });
  });

  it("continues successful slot revalidation directly to command preparation", () => {
    expect(
      routeAfterAgentTools(
        clinicState({
          contactContext: ownedContactContext(),
          bookingDraft: canonicalBookingDraft({
            phase: "confirming",
            serviceAcceptance: {
              status: "accepted",
              service: {
                id: "svc-1",
                name: "Процедура",
                durationMinutes: 30,
                source: "catalog",
              },
            },
            pendingCommand: {
              action: "create",
              payload: { serviceId: "svc-1" },
            },
          }),
          agentMessages: [
            new ToolMessage({
              content: JSON.stringify({
                date: "2026-09-10",
                slots: [{
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
                // Snapshot metadata is not authoritative; the exact interval is.
                stepMinutes: 45,
              }),
              name: "present_availability_slots",
              tool_call_id: "revalidate-1",
            }),
          ],
        }),
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__command_prepare");
  });

  it("does not continue command preparation when fresh revalidation fails", () => {
    expect(
      routeAfterAgentTools(
        clinicState({
          bookingDraft: canonicalBookingDraft({
            phase: "confirming",
            pendingCommand: {
              action: "create",
              payload: { serviceId: "svc-1" },
            },
          }),
          agentMessages: [
            new ToolMessage({
              content: JSON.stringify({ error: "CRM unavailable" }),
              name: "present_availability_slots",
              tool_call_id: "revalidate-1",
            }),
          ],
        }),
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
      ),
    ).toBe("booking__llm");
  });

  it("routes incomplete-contact booking errors to the model without retrying the mutation", () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{ id: "c-1", firstName: "Ada", missingFields: ["lastName"] }],
      },
      bookingDraft: canonicalBookingDraft({ contactId: "c-1" }),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "Contact incomplete", missingFields: ["lastName"] }),
        name: "create_meeting",
        tool_call_id: "create-incomplete-1",
      })],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__llm");
    expect(routeAfterAgentLlm(
      { ...state, agentMessages: [...state.agentMessages, new AIMessage("Назвіть, будь ласка, прізвище.")] },
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__finalize");
  });

  it("does not rebuild a reschedule after authorization failure until identity is refreshed", () => {
    const state = clinicState({
      contactContext: null,
      bookingContext: null,
      bookingDraft: canonicalBookingDraft({
        mode: "reschedule",
        phase: "confirming",
        contactId: null,
        selectedDate: "2026-09-10",
        selectedSlot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
        },
        pendingCommand: {
          action: "reschedule",
          payload: { meetingId: "m-1" },
        },
        rescheduleTarget: { id: "m-1" },
      }),
      agentMessages: [new ToolMessage({
        content: JSON.stringify({ error: "Not authorized" }),
        name: "reschedule_meeting",
        tool_call_id: "reschedule-auth-1",
      })],
    });
    const invalidated = reduceBookingDraft(state.bookingDraft, { type: "contact_unresolved" });
    const afterFailure = { ...state, bookingDraft: invalidated };

    expect(invalidated).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: null,
      selectedDate: null,
      selectedSlot: null,
      pendingCommand: null,
    });
    expect(routeAfterAgentTools(
      afterFailure,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__llm");
    expect(routeAfterAgentPrepare(afterFailure, "booking__llm", "booking__command_prepare"))
      .toBe("booking__llm");
  });
});

describe("createAgentFinalizeNode", () => {
  it("replaces model prose with the service-change notice while DATE reselection is open", () => {
    const finalize = createAgentFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const update = finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "answered", value: "запиши на збільшення губ" },
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Збільшення губ Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
        }),
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(notice);
    expect(update.lastHandoff?.replyText).not.toContain("booked");
    expect(update.serviceChangeNotice).toBeNull();
  });

  it("replaces any-language model prose with the code-owned DATE prompt", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
        }),
        agentMessages: [new AIMessage("Done — your appointment is confirmed.")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyButtons ?? []).toEqual([]);
  });

  it("recovers the TIME card from checkpoint when selectedDate is still open", () => {
    const finalize = createAgentFinalizeNode(agent);
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-19",
        dayLabel: "19 жовтня (понеділок)",
        slots: [
          { id: "s1", label: "11:30", dateStart: "2026-10-19T11:30:00", dateEnd: "2026-10-19T12:00:00" },
          { id: "s2", label: "12:30", dateStart: "2026-10-19T12:30:00", dateEnd: "2026-10-19T13:00:00" },
        ],
      },
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          { id: "s3", label: "12:00", dateStart: "2026-10-20T12:00:00", dateEnd: "2026-10-20T12:30:00" },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          { id: "s4", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
          { id: "s5", label: "11:30", dateStart: "2026-10-22T11:30:00", dateEnd: "2026-10-22T12:00:00" },
          { id: "s6", label: "12:00", dateStart: "2026-10-22T12:00:00", dateEnd: "2026-10-22T12:30:00" },
          { id: "s7", label: "14:30", dateStart: "2026-10-22T14:30:00", dateEnd: "2026-10-22T15:00:00" },
        ],
      },
    ];
    const update = finalize(
      clinicState({
        messages: [new HumanMessage("все ж таки запиши на консультацію")],
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: "2026-10-22",
          selectedSlot: null,
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "6a884971a722ecdf2",
              name: "Ботулінотерапія Botox, Disport 2 зони",
              durationMinutes: 30,
              source: "catalog",
            },
          },
        }),
        availabilityContext: {
          serviceId: "6a884971a722ecdf2",
          days,
          stepMinutes: 30,
          query: {
            kind: "nearest",
            anchor: "2026-10-07",
            rangeFrom: "2026-10-07",
            rangeThrough: "2026-10-22",
            coverageComplete: true,
          },
        },
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    const expected = formatAvailabilityTimeOffer(days[2]!);
    expect(update.lastHandoff?.replyText).toBe(expected.replyText);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
    expect(update.lastHandoff?.replyText).not.toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyText).not.toContain("booked");
  });

  it("recovers the DATE card from checkpoint when selectedDate is cleared", () => {
    const finalize = createAgentFinalizeNode(agent);
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          { id: "s1", label: "12:00", dateStart: "2026-10-20T12:00:00", dateEnd: "2026-10-20T12:30:00" },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          { id: "s2", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
        ],
      },
    ];
    const availability: AvailabilityContext = {
      serviceId: "svc-1",
      days,
      stepMinutes: 30,
      query: {
        kind: "nearest",
        rangeFrom: "2026-10-08",
        rangeThrough: "2026-10-22",
        coverageComplete: true,
      },
    };
    const update = finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
        }),
        availabilityContext: availability,
        agentMessages: [new AIMessage("Done — your appointment is confirmed.")],
      }),
    );

    const expected = formatAvailabilityDateOffer(availability);
    expect(update.lastHandoff?.replyText).toBe(expected.replyText);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
  });

  it("does not reuse a checkpoint snapshot for a different accepted service", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-consult",
              name: "Консультація",
              durationMinutes: 30,
              source: "catalog",
            },
          },
        }),
        availabilityContext: {
          serviceId: "svc-botox",
          days: [
            {
              date: "2026-10-22",
              dayLabel: "22 жовтня (четвер)",
              slots: [
                {
                  id: "s1",
                  label: "11:00",
                  dateStart: "2026-10-22T11:00:00",
                  dateEnd: "2026-10-22T11:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyButtons ?? []).toEqual([]);
  });

  it("prefixes a recovered TIME card with the service-change notice", () => {
    const finalize = createAgentFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Консультація");
    const day: AvailabilityContext["days"][number] = {
      date: "2026-10-22",
      dayLabel: "22 жовтня (четвер)",
      slots: [
        { id: "s1", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
        { id: "s2", label: "12:00", dateStart: "2026-10-22T12:00:00", dateEnd: "2026-10-22T12:30:00" },
      ],
    };
    const update = finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: "2026-10-22",
          selectedSlot: null,
        }),
        availabilityContext: {
          serviceId: "svc-1",
          days: [day],
          stepMinutes: 30,
        },
        agentMessages: [new AIMessage("Готово!")],
      }),
    );

    const expected = formatAvailabilityTimeOffer(day);
    expect(update.lastHandoff?.replyText).toBe(`${notice}\n\n${expected.replyText}`);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
    expect(update.serviceChangeNotice).toBeNull();
  });

  it("prefixes the DATE card with the service-change notice and then clears it", () => {
    const finalize = createAgentFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          {
            id: "s1",
            label: "12:00",
            dateStart: "2026-10-20T12:00:00",
            dateEnd: "2026-10-20T13:00:00",
          },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          {
            id: "s2",
            label: "11:00",
            dateStart: "2026-10-22T11:00:00",
            dateEnd: "2026-10-22T12:00:00",
          },
        ],
      },
    ];
    const update = finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "answered", value: "запиши на збільшення губ" },
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Збільшення губ Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
        }),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "slots-1",
              name: "present_availability_slots",
              args: { direction: "nearest", durationMinutes: 60 },
              type: "tool_call",
            }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              days,
              stepMinutes: 60,
              query: {
                kind: "nearest",
                rangeFrom: "2026-10-08",
                rangeThrough: "2026-10-22",
                coverageComplete: true,
              },
            }),
            tool_call_id: "slots-1",
            name: "present_availability_slots",
          }),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    const reply = String(update.lastHandoff?.replyText ?? "");
    expect(reply.startsWith(notice)).toBe(true);
    expect(reply).toContain("20 жовтня");
    expect(reply).toContain("22 жовтня");
    expect(reply).not.toContain("Запис створено");
    expect(update.serviceChangeNotice).toBeNull();
    expect(update.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["20 жовтня", "22 жовтня"]),
    );
  });

  it.each([
    "Готово! Запис створено.",
    "Готово! Запис перенесено.",
    "Запис скасовано.",
    "Вас записано на консультацію.",
    "Ви записані на процедуру.",
    "Бронювання підтверджено.",
  ])("code-owns the unresolved-contact question regardless of model prose: %s", (claim) => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [new HumanMessage("Продовжити без коментаря"), new AIMessage(claim)],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_QUESTION_UK);
    expect(extractMessageTextContent((update.messages as AIMessage[])[0]!.content)).toBe(
      BOOKING_PHONE_QUESTION_UK,
    );
  });

  it("code-owns the occupied-phone reply and clears the phone candidate", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [
          new HumanMessage("+380 63 212 3123"),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_OCCUPIED_UK);
    expect(extractMessageTextContent((update.messages as AIMessage[])[0]!.content)).toBe(
      BOOKING_PHONE_OCCUPIED_UK,
    );
    expect(update.contactContext).toBeNull();
  });

  it("keeps the linkable phone-candidate fallback until link succeeds", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: null,
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [
          new HumanMessage("+380 63 212 3123"),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(PATIENT_FALLBACK_MESSAGE);
    expect(update.contactContext).toBeUndefined();
  });

  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("strips reply_buttons from checkpointed history and code-owns consultation shortcuts", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [
          new AIMessage(
            "Підібрати вільний час на консультацію?\n\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "booking",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
    });
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
  });

  it("persists the consultation as a pending service when the offer is shown", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );

    expect(update.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
    });
  });

  it("does not send leaked Gemini tool XML as the patient reply", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "<call:default_api:present_availability_slots{afterDate: 2026-09-29,durationMinutes:30}></call:default_api:present_availability_slots>",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText ?? "").not.toContain("call:default_api");
    expect(String((update.messages?.[0] as AIMessage | undefined)?.content ?? "")).not.toContain(
      "call:default_api",
    );
  });

  it("DDD-53: attaches BOOKING OFFER when the consultation question has no trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
  });

  it("replaces a wrong consultation trailer with BOOKING OFFER", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [
          new AIMessage(
            "Записати вас на консультацію?\n<reply_buttons>\nЗаписатись\nПослуги\n</reply_buttons>",
          ),
        ],
      }),
    );

    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
  });

  it("strips an empty reply_buttons trailer and omits DEFAULT MENU for mid-flow booking", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "Could you please provide your phone number?\n<reply_buttons>\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Could you please provide your phone number?");
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyText).toBe("Could you please provide your phone number?");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("attaches REPLACE when create_meeting returned Already booked and no trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "create_meeting", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              error: "Already booked",
              meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-09-04 11:00:00" }],
            }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage(
            "У вас вже є запланований візит. Бажаєте скасувати поточний і записати нову?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual(["Скасувати", "Ні, дякую"]);
    expect(update.lastHandoff?.status).toBe("ok");
  });

  it("attaches DEFAULT has-visits after a committed create_meeting", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "create_meeting", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              id: "m-new",
              name: "Консультація - Ada",
              dateStart: "2026-09-10 14:00:00",
            }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на консультацію 10 вересня (четвер) о 14:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("Готово!");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("attaches DEFAULT no-visits after cancelling the only planned meeting", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        bookingContext: listedMeetings,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "cancel_meeting", args: { meetingId: "m-1" } }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-1",
            }),
            tool_call_id: "1",
            name: "cancel_meeting",
          }),
          new AIMessage(
            "Візит успішно скасовано. Чи бажаєте підібрати новий час для запису?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("скасовано");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("keeps DEFAULT has-visits after cancelling one of several meetings", () => {
    const finalize = createAgentFinalizeNode(agent);
    const twoMeetings: BookingContext = {
      meetings: [
        ...listedMeetings.meetings,
        {
          id: "m-2",
          name: "Консультація - Ada",
          dateStart: "2026-08-20 10:00:00",
          dateEnd: "2026-08-20 10:30:00",
        },
      ],
      dateFrom: listedMeetings.dateFrom,
    };
    const update = finalize(
      clinicState({
        stepCount: 2,
        bookingContext: twoMeetings,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "cancel_meeting", args: { meetingId: "m-1" } }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-1",
            }),
            tool_call_id: "1",
            name: "cancel_meeting",
          }),
          new AIMessage("Візит успішно скасовано."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("DDD-54: attaches DEFAULT MENU after HITL decline on create_meeting", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "create_meeting", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({ cancelled: true }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage("Нічого не записано. Можемо підібрати інший час, коли будете готові."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("DDD-54: attaches DEFAULT has-visits after a committed reschedule_meeting", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        bookingContext: listedMeetings,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "reschedule_meeting", args: { meetingId: "m-1" } }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              id: "m-1",
              name: "Консультація - Ada",
              dateStart: "2026-09-10 14:00:00",
              dateEnd: "2026-09-10 15:00:00",
            }),
            tool_call_id: "1",
            name: "reschedule_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на консультацію 10 вересня (четвер) о 14:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("DDD-54: emits reply_menu_filled when attaching DEFAULT MENU on idle", () => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    try {
      const finalize = createAgentFinalizeNode(agent);
      finalize(
        clinicState({
          stepCount: 2,
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: "1", name: "create_meeting", args: {} }],
            }),
            new ToolMessage({
              content: JSON.stringify({
                id: "m-new",
                name: "Консультація - Ada",
                dateStart: "2026-09-10 14:00:00",
              }),
              tool_call_id: "1",
              name: "create_meeting",
            }),
            new AIMessage(`Готово!\n\n${CLINIC_ADDRESS}`),
          ],
        }),
      );

      expect(seen).toContainEqual({
        name: "reply_menu_filled",
        props: { menu: "default", reason: "idle" },
      });
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("keeps REPLACE when Already booked and present_availability_slots ran same turn", () => {
    const finalize = createAgentFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "a",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T15:00:00",
          },
        ],
      },
    ];
    const update = finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 60 },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "slots", name: "present_availability_slots", args: {} },
              { id: "create", name: "create_meeting", args: {} },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 60 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new ToolMessage({
            content: JSON.stringify({
              error: "Already booked",
              meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-09-04 11:00:00" }],
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new AIMessage(
            "У вас вже є запланований візит. Бажаєте скасувати поточний і записати нову?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual(["Скасувати", "Ні, дякую"]);
    expect(update.lastHandoff?.replyText).toContain("запланований візит");
    expect(update.lastHandoff?.replyText).not.toContain("Найближчі вільні дні");
  });

  it("keeps Готово + DEFAULT when committed create and present_availability_slots ran same turn", () => {
    const finalize = createAgentFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-29",
        dayLabel: "29 вересня (вівторок)",
        slots: [
          {
            id: "a",
            label: "12:00",
            dateStart: "2026-09-29T12:00:00",
            dateEnd: "2026-09-29T13:00:00",
          },
        ],
      },
    ];
    const update = finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 60 },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "slots", name: "present_availability_slots", args: {} },
              { id: "create", name: "create_meeting", args: {} },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 60 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-new",
              name: "Збільшення губ Neotiva - Daniel Test",
              dateStart: "2026-09-29 12:00:00",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на збільшення губ Neotiva 29 вересня (вівторок) о 12:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("Готово!");
    expect(update.lastHandoff?.replyText).not.toContain("Найближчі вільні дні");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("prefixes DATE offer when create_meeting overlaps and slots ran same turn", () => {
    const finalize = createAgentFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-15",
        dayLabel: "15 вересня (вівторок)",
        slots: [
          {
            id: "a",
            label: "11:00",
            dateStart: "2026-09-15T11:00:00",
            dateEnd: "2026-09-15T11:30:00",
          },
          {
            id: "b",
            label: "14:30",
            dateStart: "2026-09-15T14:30:00",
            dateEnd: "2026-09-15T15:00:00",
          },
        ],
      },
      {
        date: "2026-09-28",
        dayLabel: "28 вересня (понеділок)",
        slots: [
          {
            id: "c",
            label: "11:00",
            dateStart: "2026-09-28T11:00:00",
            dateEnd: "2026-09-28T11:30:00",
          },
        ],
      },
    ];
    const update = finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 30 },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "create", name: "create_meeting", args: {} },
              { id: "slots", name: "present_availability_slots", args: {} },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({
              error: "This meeting overlaps an existing meeting for the assigned user.",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 30 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "На жаль, обраний час щойно зайняли.\n\nОсь інші дні з вигаданими годинами 09:00–18:00.",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Не вдалося створити запис");
    expect(text).not.toContain("Готово");
  });

  it("prefixes TIME offer when create_meeting overlaps and same-day slots ran this turn", () => {
    const finalize = createAgentFinalizeNode(agent);
    const day = {
      date: "2026-09-15",
      dayLabel: "15 вересня (вівторок)",
      slots: [
        {
          id: "2026-09-15T1430",
          label: "14:30",
          dateStart: "2026-09-15T14:30:00",
          dateEnd: "2026-09-15T15:00:00",
        },
      ],
    };
    const update = finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days: [day], stepMinutes: 30 },
        agentMessages: [
          new HumanMessage("11:00"),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "create", name: "create_meeting", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              error: "This meeting overlaps an existing meeting for the assigned user.",
              hint: "That time may already be booked.",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "slots", name: "present_availability_slots", args: { date: "2026-09-15" } },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({
              slots: day.slots,
              date: day.date,
              dayLabel: day.dayLabel,
              stepMinutes: 30,
            }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "На жаль, 15 вересня о 11:00 вже зайнято. Залишився вільний час на цей день:\n\n  - 14:30\n\nБажаєте обрати цей час?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Не вдалося створити запис");
    expect(text).not.toContain("Готово");
  });

  it("delivers model-failure fallback via handoff only (no history, no sticky ok)", async () => {
    const { createAgentLlmNode } = await import("../agent-loop.js");
    const { PATIENT_FALLBACK_MESSAGE } = await import("../../shared/clinic-constants.js");
    const bindTools = vi.fn(() => ({
      invoke: vi.fn(async () => {
        throw new Error("model down");
      }),
    }));
    const model = { bindTools } as unknown as BaseChatModel;
    const llm = createAgentLlmNode({
      agent,
      model,
      tools: [],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      clinicState({ agentMessages: [new HumanMessage("hi")], next: "booking" }),
    );
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: llmUpdate.stepCount ?? 1,
        agentMessages: llmUpdate.agentMessages as never,
      }),
    );

    expect(update.messages).toBeUndefined();
    expect(update.lastHandoff).toMatchObject({
      agentId: "booking",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: ["Записатись", "Послуги", "Адреса"],
    });
  });

  it("code-owns FAQ consultation yield and BOOKING OFFER without tags", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("запиши на консультацію")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [new AIMessage("Записати вас на консультацію?")],
      }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
      yieldToSupervisor: true,
    });
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.bookingDraft?.serviceAcceptance?.status).toBe("pending");
  });

  it("stores yieldToSupervisor and strips the yield tag from checkpointed history", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("запиши на консультацію")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [
          new AIMessage(
            "Записати вас на консультацію?\n<yield_to_supervisor/>\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
      yieldToSupervisor: true,
    });
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
  });

  it("strips a yield-only trailer and omits DEFAULT MENU for faq", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingContext: listedMeetings,
        agentMessages: [new AIMessage("Done.\n<yield_to_supervisor/>")],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Done.");
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyText: "Done.",
      yieldToSupervisor: true,
    });
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("does not open FAQ catalog chips from list_services alone in finalize", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingContext: listedMeetings,
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

    expect(update.pendingInteraction?.kind).not.toBe("service_candidate");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("attaches BOOKING OFFER on Послуги (not catalog chips) even with leftover mutation_confirm", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        bookingContext: listedMeetings,
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

    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("У нашій клініці доступні такі напрями");
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(update.lastHandoff?.replyText).not.toContain("Записати вас на консультацію?");
    expect(update.lastHandoff?.replyText?.trimStart().startsWith("•")).toBe(false);
  });

  it("appends a consultation offer on Послуги when the model only asked which direction", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        bookingContext: listedMeetings,
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

    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyText).toContain("У нашій клініці доступні такі напрями");
    // Non-offer clarifying questions stay; only duplicate offer copy is stripped.
    expect(update.lastHandoff?.replyText).toContain("Який напрямок вам цікавий?");
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
    expect(
      (update.lastHandoff?.replyText ?? "")
        .split("Підібрати вільний час на консультацію?").length - 1,
    ).toBe(1);
  });

  it("replaces divergent model FAQ catalog prose with structured-choice bullets", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
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
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingContext: listedMeetings,
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

  it("keeps FAQ catalog chips when draft still has a pending serviceAcceptance", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
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
    expect(update.pendingInteraction?.kind).not.toBe("service_confirm");
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
    const prepare = createAgentPrepareNode("faq", {
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

    expect(prepared.pendingInteraction?.kind).toBe("service_candidate");

    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Обрати іншу процедуру")],
        bookingDraft: prepared.bookingDraft ?? canonicalBookingDraft({
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
        pendingInteraction: prepared.pendingInteraction ?? null,
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

  it("keeps FAQ catalog choice ids when narrowing remaining CRM rows", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);

    const families = finalize(
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
    expect(families.lastHandoff?.replyText).toContain("Доступні такі варіанти:");

    const zones = finalize(
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

    const brands = finalize(
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

  it("opens FAQ catalog choices for consultation service names from CRM", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
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

  it("attaches BOOKING OFFER (not catalog bullets) on a consultation offer without a trailer", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("запиши на консультацію")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [
          new AIMessage(
            "У нашій клініці доступні такі напрями\n\n• Консультації та діагностика\n• Ін'єкційні процедури\n\nЗаписати вас на консультацію?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
  });

  it("DDD-79: booking fills Yes/Other keyboard when consultation offer omits the trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
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
    expect(update.pendingInteraction?.kind).toBe("service_confirm");
  });

  it("DDD-54: booking omits DEFAULT MENU for non-offer mid-flow replies without a trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
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

  it("prefers open FAQ catalog interaction over an accidental leftover trailer", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
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
    expect(update.lastHandoff?.replyText).toContain("Доступні такі варіанти:");
    expect(update.lastHandoff?.replyText).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyText).not.toContain("faq_catalog_action");
    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
    expect(String(update.messages?.[0]?.content)).not.toContain("faq_catalog_action");
  });

  it("replaces a model catalog list with one structured list from choices", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
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
    const update = finalize(
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

  it("falls back to the catalog template when the model reply is empty", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const choices = [
      { id: "g0", label: "Консультації та діагностика", serviceIds: ["a"] },
      { id: "g1", label: "Ін'єкційні процедури", serviceIds: ["b"] },
    ];
    const update = finalize(
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

  it("offer_consultation preserves model explanation and appends one consultation question", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const explanation =
      "Для губ ми використовуємо кілька якісних препаратів — лікар під час консультації підбере той, що найкраще підійде саме вам 🌿";
    const update = finalize(
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

    expect(update.pendingInteraction?.kind).toBe("service_confirm");
    expect(update.pendingInteraction).toMatchObject({
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

  it("offer_consultation keeps mid-text questions and only strips a trailing yes/no", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const explanation =
      "Що таке Disport? Це препарат для ботулінотерапії; дозування підбирає лікар.";
    const update = finalize(
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

  it("offer_consultation keeps a non-offer trailing question (allergy) and appends the graph offer", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const allergy = "Чи є у вас алергія на лідокаїн?";
    const update = finalize(
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

    expect(update.lastHandoff?.replyText).toContain(allergy);
    expect(update.lastHandoff?.replyText).toContain("Підібрати вільний час на консультацію?");
  });

  it("close_catalog clears chips and keeps hours/location answers", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const hours = "Ми працюємо щодня з 9:00 до 20:00.";
    const update = finalize(
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

    expect(update.pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(hours);
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("preserves product/price/comparison answers while the catalog is open", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
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

    const product = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("що таке Disport?")],
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Disport — препарат для ботулінотерапії; дозування підбирає лікар.", "offer_consultation"),
        ],
      }),
    );
    expect(product.lastHandoff?.replyText).toContain("Disport — препарат");
    expect(product.lastHandoff?.replyText).not.toMatch(/^Доступні такі варіанти:/);
    expect(product.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);

    const price = finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("скільки це коштує?")],
        pendingInteraction: pending,
        agentMessages: [
          faqCatalogAi("Вартість залежить від препарату:\n• Disport — 4500 грн\n• Nabota — 4200 грн", "offer_consultation"),
        ],
      }),
    );
    expect(price.lastHandoff?.replyText).toContain("4500 грн");
    expect(price.lastHandoff?.replyText).not.toMatch(/^Доступні такі варіанти:/);

    const comparison = finalize(
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

  it("keeps consultation service_confirm and BOOKING_OFFER_MENU on price follow-ups", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const priceAnswer =
      "Вартість залежить від обраного препарату:\n• Neotiva — 8500 грн\n• Juvederm — 9200 грн";
    const update = finalize(
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
    expect(update.pendingInteraction).toBeUndefined();
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
  });

  it("keeps procedure service_confirm and BOOKING_OFFER_MENU after Скільки коштує", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const priceAnswer =
      "Вартість процедури «Лікування гіпергідрозу» — 8071 грн.\n\nБажаєте записатися на цю процедуру?";
    const update = finalize(
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
    expect(update.pendingInteraction).toBeUndefined();
    expect(update.lastHandoff?.yieldToSupervisor).toBe(true);
  });

  it("keeps catalog chips on missing or invalid faq_catalog_action via deterministic body", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
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

    const missing = finalize(
      clinicState({
        stepCount: 1,
        pendingInteraction: pending,
        agentMessages: [new AIMessage("Коротке уточнення без action-тега.")],
      }),
    );
    expect(missing.lastHandoff?.replyText).toBe(expectedBody);
    expect(missing.lastHandoff?.replyButtons).toEqual(["Disport", "Nabota"]);
    expect(String(missing.messages?.[0]?.content)).not.toContain("faq_catalog_action");

    const invalid = finalize(
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

  it("shows displayLabel in prose while shortened label stays on the keyboard", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
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
    const update = finalize(
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

  it("preserves FAQ service_confirm prose when the model already confirmed the procedure", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingContext: listedMeetings,
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

  it("strips an accidental catalog trailer when no FAQ catalog interaction is open", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
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
    expect(update.pendingInteraction ?? null).toBeNull();
  });

  it("does not attach buttons for faq location-only replies", () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createAgentFinalizeNode(faqAgent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(`Ми знаходимося за адресою ${CLINIC_ADDRESS}.`),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  const moveSnapshot: AvailabilityContext = {
    days: [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "2026-09-10T1400",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T15:00:00",
          },
        ],
      },
      {
        date: "2026-09-11",
        dayLabel: "11 вересня (п'ятниця)",
        slots: [
          {
            id: "2026-09-11T1200",
            label: "12:00",
            dateStart: "2026-09-11T12:00:00",
            dateEnd: "2026-09-11T13:00:00",
          },
        ],
      },
      {
        date: "2026-09-12",
        dayLabel: "12 вересня (субота)",
        slots: [
          {
            id: "2026-09-12T1100",
            label: "11:00",
            dateStart: "2026-09-12T11:00:00",
            dateEnd: "2026-09-12T12:00:00",
          },
        ],
      },
    ],
    stepMinutes: 60,
    excludeMeetingIds: ["6a95fe6e5b90474bc"],
  };

  it("replaces invented 09:00–18:00 with DATE offer (hours in text, date keyboard)", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        availabilityContext: moveSnapshot,
        agentMessages: [
          new HumanMessage("Перенести"),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "1", name: "present_availability_slots", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              date: "2026-09-10",
              slots: moveSnapshot.days[0]!.slots,
              days: moveSnapshot.days,
              stepMinutes: 60,
              searchedDays: 12,
              excludeMeetingIds: moveSnapshot.excludeMeetingIds,
            }),
            tool_call_id: "1",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "Вільні години на 10 вересня (четвер) 🗓️\n\n  - 09:00\n  - 10:00\n  - 11:00\n  - 12:00\n  - 13:00\n  - 14:00\n  - 15:00\n  - 16:00\n  - 17:00\n  - 18:00\n\nЯкий час вам зручний?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("10 вересня (четвер): 14:00");
    expect(text).toContain("11 вересня (п'ятниця): 12:00");
    expect(text).toContain("12 вересня (субота): 11:00");
    expect(text).not.toContain("18:00");
    expect(text).not.toContain("09:00");
    expect(update.lastHandoff?.replyButtons).toEqual([
      "10 вересня",
      "11 вересня",
      "12 вересня",
      OTHER_DATE_LABEL,
    ]);
    expect(String(update.messages?.[0]?.content)).toBe(text);
  });

  it("on day pick without a new tool call, rewrites to TIME from availabilityContext", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: moveSnapshot,
        agentMessages: [
          new HumanMessage("10 вересня"),
          new AIMessage(
            "Вільні години на 10 вересня (четвер) 🗓️\n\n  - 09:00\n  - 10:00\n  - 18:00\n\nЯкий час вам зручний?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Вільні години на 10 вересня (четвер)");
    expect(text).toContain("14:00");
    expect(text).not.toContain("18:00");
    expect(text).not.toContain("09:00");
    expect(update.lastHandoff?.replyButtons).toEqual(["14:00", OTHER_DATE_LABEL]);
  });

  it("omits DEFAULT MENU when availability snapshot is empty and there is no trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: { days: [], stepMinutes: 60 },
        agentMessages: [
          new HumanMessage("Записатись"),
          new AIMessage("Could you please provide your phone number?"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe("Could you please provide your phone number?");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });
});

describe("runtime-owned cancellation outcomes", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  const cancellationMessages = (content: unknown): [AIMessage, ToolMessage] => [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "cancel-1", name: "cancel_meeting", args: { meetingId: "m-1" } }],
    }),
    new ToolMessage({
      content: JSON.stringify(content),
      tool_call_id: "cancel-1",
      name: "cancel_meeting",
    }),
  ];

  it("classifies cancellation decline separately from pending confirmation", () => {
    expect(classifyMeetingMutationToolMessage(cancellationMessages({ cancelled: true })[1]))
      .toBe("declined");
    expect(classifyMeetingMutationToolMessage(new ToolMessage({
      content: JSON.stringify({ awaitingConfirmation: true }),
      tool_call_id: "pending-1",
      name: "cancel_meeting",
    }))).toBe("pending_confirmation");
  });

  it("renders a declined cancellation with an actionable visit-change menu", () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      messages: [new HumanMessage("❌")],
      bookingContext: listedMeetings,
      agentMessages: cancellationMessages({ cancelled: true }),
    }));

    expect(update.lastHandoff).toMatchObject({
      status: "ok",
      replyText: "Запис не було скасовано.",
      replyButtons: [...VISIT_CHANGE_MENU],
    });
    expect(update.bookingDraft).toBeNull();
  });

  it("renders committed cancellation without model-authored success text", () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingContext: listedMeetings,
      agentMessages: cancellationMessages({ id: "m-1", success: true }),
    }));

    expect(update.lastHandoff?.replyText).toBe("Запис скасовано.");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("renders a replacement cancellation decline with the default booking menu", () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingContext: listedMeetings,
      pendingCancellationPurpose: "replacement",
      agentMessages: cancellationMessages({ cancelled: true }),
    }));

    expect(update.lastHandoff).toMatchObject({
      status: "ok",
      replyText: "Скасування поточного візиту скасовано. Новий запис не було створено.",
      replyButtons: [...DEFAULT_MENU_HAS_VISITS],
    });
  });

  it("routes terminal direct cancellation outcomes around the booking LLM", () => {
    expect(routeAfterAgentTools(
      clinicState({
        bookingContext: listedMeetings,
        agentMessages: cancellationMessages({ cancelled: true }),
      }),
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
    )).toBe("booking__mutation_finalize");
  });

  it("routes a declined replacement cancellation to runtime finalization", () => {
    expect(routeAfterAgentTools(
      clinicState({
        bookingContext: listedMeetings,
        pendingCancellationPurpose: "replacement",
        agentMessages: cancellationMessages({ cancelled: true }),
      }),
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
    )).toBe("booking__mutation_finalize");
  });

  it("routes a typed reschedule decline directly to deterministic finalization", () => {
    // Adapter maps NL decline to { confirmed: false } → cancelled tool result.
    const state = clinicState({
      bookingContext: listedMeetings,
      bookingDraft: canonicalBookingDraft({
        mode: "reschedule",
        phase: "confirming",
        selectedDate: "2026-09-10",
        pendingCommand: {
          action: "reschedule",
          payload: {
            meetingId: "m-1",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          },
        },
        rescheduleTarget: { id: "m-1", name: "Consult" },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            cancelled: true,
            message: "Patient declined.",
          }),
          tool_call_id: "reschedule-1",
          name: "reschedule_meeting",
        }),
      ],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
    )).toBe("booking__mutation_finalize");

    const declined = createAgentMutationFinalizeNode(agent)(state);
    expect(declined.lastHandoff).toMatchObject({
      status: "ok",
      replyText: "Запис не було перенесено.",
    });
    expect(declined.lastHandoff?.replyText).not.toContain("вільні");
    expect(declined.bookingDraft).toBeNull();
    expect(declined.pendingCancellationPurpose).toBeNull();
  });

  it("routes HITL other-reply after skip to the booking LLM, not the note orchestrator", () => {
    const state = clinicState({
      messages: [new HumanMessage("запиши на ботокс")],
      contactContext: ownedContactContext(),
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        note: { status: "skipped" },
        pendingCommand: {
          action: "create",
          payload: {
            serviceId: "svc-1",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          },
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "запиши на ботокс",
            draft: { command: { action: "create", payload: {} } },
          }),
          name: "create_meeting",
          tool_call_id: "create-1",
        }),
      ],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
      "booking__note_orch",
    )).toBe("booking__llm");
  });

  it("still routes HITL other-reply to note orch while keep/switch is open", () => {
    const state = clinicState({
      messages: [new HumanMessage("Змінити послугу")],
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        note: { status: "skipped" },
        pendingCommand: {
          action: "create",
          payload: { serviceId: "svc-1", dateStart: "2026-09-10T14:00:00" },
        },
      }),
      pendingInteraction: {
        kind: "service_or_note",
        currentService: { id: "svc-1", name: "Процедура" },
        noteCandidate: "запиши на ботокс",
        choices: [
          { id: "keep_service", label: "Продовжити з обраною послугою" },
          { id: "switch_service", label: "Змінити послугу" },
        ],
      },
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "Змінити послугу",
            draft: { command: { action: "create", payload: {} } },
          }),
          name: "create_meeting",
          tool_call_id: "create-1",
        }),
      ],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
      "booking__note_orch",
    )).toBe("booking__note_orch");
  });

  it("still sends declined HITL chat to mutation finalize, not the note orch", () => {
    const state = clinicState({
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        note: { status: "skipped" },
        pendingCommand: {
          action: "create",
          payload: { serviceId: "svc-1", dateStart: "2026-09-10T14:00:00" },
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            cancelled: true,
            message: "Patient declined.",
          }),
          name: "create_meeting",
          tool_call_id: "create-1",
        }),
      ],
    });

    expect(routeAfterAgentTools(
      state,
      "booking__llm",
      "booking__tools",
      "booking__mutation_finalize",
      "booking__command_prepare",
      "booking__note_orch",
    )).toBe("booking__mutation_finalize");
  });
});

describe("replacement offer menu precedence", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("keeps replacement consent buttons when the note step is still awaiting", () => {
    const update = createAgentFinalizeNode(agent)(clinicState({
      bookingDraft: {
        version: 3,
        mode: "replace",
        phase: "confirming",
        serviceAcceptance: {
          status: "accepted",
          service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        },
        availability: null,
        selectedDate: "2026-09-10",
        selectedSlot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
        },
        note: { status: "awaiting" },
        contactId: "c-1",
        pendingCommand: null,
        replacement: {
          meeting: { id: "existing-1", name: "Existing visit" },
          status: "offered",
        },
      },
      agentMessages: [new AIMessage("Поточний запис заважає створити новий. Бажаєте замінити його?")],
    }));

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
    expect(update.lastHandoff?.replyButtons).not.toContain(INTENT_SKIP_LABEL);
  });
});

describe("availability offer helpers", () => {
  const days: AvailabilityContext["days"] = [
    {
      date: "2026-09-10",
      dayLabel: "10 вересня (четвер)",
      slots: [
        {
          id: "a",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T15:00:00",
        },
        {
          id: "b",
          label: "15:00",
          dateStart: "2026-09-10T15:00:00",
          dateEnd: "2026-09-10T16:00:00",
        },
      ],
    },
    {
      date: "2026-09-11",
      dayLabel: "11 вересня (п'ятниця)",
      slots: [
        {
          id: "c",
          label: "12:00",
          dateStart: "2026-09-11T12:00:00",
          dateEnd: "2026-09-11T13:00:00",
        },
      ],
    },
  ];

  it("formatAvailabilityDateOffer lists hours and keeps date-only shortcuts", () => {
    const offer = formatAvailabilityDateOffer(days);
    expect(offer.replyText).toContain("10 вересня (четвер): 14:00, 15:00");
    expect(offer.replyText).toContain("11 вересня (п'ятниця): 12:00");
    expect(offer.replyButtons).toEqual(["10 вересня", "11 вересня", OTHER_DATE_LABEL]);
  });

  it("uses the canonical search query to describe paginated date pages", () => {
    const base: AvailabilityContext = { days, stepMinutes: 30 };

    expect(formatAvailabilityHeading({
      ...base,
      query: {
        kind: "nearest",
        rangeFrom: "2026-09-24",
        rangeThrough: "2026-10-10",
        coverageComplete: true,
      },
    })).toBe("Найближчі вільні дні");
    expect(formatAvailabilityHeading({
      ...base,
      query: {
        kind: "later",
        anchor: "2026-10-12",
        rangeFrom: "2026-10-13",
        rangeThrough: "2026-11-11",
        coverageComplete: true,
      },
    })).toBe("Вільні дні після 12 жовтня");
    expect(formatAvailabilityHeading({
      ...base,
      query: {
        kind: "earlier",
        anchor: "2026-10-15",
        rangeFrom: "2026-09-16",
        rangeThrough: "2026-10-14",
        coverageComplete: true,
      },
    })).toBe("Вільні дні до 15 жовтня");
    expect(formatAvailabilityHeading(base)).toBe("Доступні дні");
  });

  it("uses the query-aware heading in paginated date offers", () => {
    const offer = formatAvailabilityDateOffer({
      days,
      stepMinutes: 30,
      searchDirection: "later",
      searchAnchor: "2026-10-12",
      query: {
        kind: "later",
        anchor: "2026-10-12",
        rangeFrom: "2026-10-13",
        rangeThrough: "2026-11-11",
        coverageComplete: true,
      },
    });

    expect(offer.replyText).toContain("Вільні дні після 12 жовтня");
    expect(offer.replyText).not.toContain("Найближчі вільні дні");
  });

  it("formatAvailabilityTimeOffer lists all times and caps shortcuts at 3", () => {
    const offer = formatAvailabilityTimeOffer(days[0]!);
    expect(offer.replyText).toContain("14:00");
    expect(offer.replyText).toContain("15:00");
    expect(offer.replyButtons).toEqual(["14:00", "15:00", OTHER_DATE_LABEL]);
  });

  it("matchAvailabilityDay accepts short keyboard labels", () => {
    expect(matchAvailabilityDay("10 вересня", days)?.date).toBe("2026-09-10");
    expect(matchAvailabilityDay(OTHER_DATE_LABEL, days)).toBeNull();
    expect(matchAvailabilityDay("Інша", days)).toBeNull();
    expect(matchAvailabilityDay(OTHER_DATE_LABEL_EN, days)).toBeNull();
    expect(matchAvailabilityDay("14:00", days)).toBeNull();
  });

  it("resolveAvailabilityOffer prefers day pick TIME over this-turn multi-day DATE", () => {
    const offer = resolveAvailabilityOffer(
      [
        new HumanMessage("10 вересня"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "present_availability_slots", args: {} }],
        }),
        new ToolMessage({
          content: JSON.stringify({ days, stepMinutes: 60 }),
          tool_call_id: "1",
          name: "present_availability_slots",
        }),
        new AIMessage("invented"),
      ],
      { days, stepMinutes: 60 },
    );
    expect(offer?.replyText).toContain("Вільні години на 10 вересня (четвер)");
    expect(offer?.replyButtons).toEqual(["14:00", "15:00", OTHER_DATE_LABEL]);
  });

  it("resolveAvailabilityOffer keeps DATE when human is not a day pick", () => {
    const offer = resolveAvailabilityOffer(
      [
        new HumanMessage(OTHER_DATE_LABEL),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "1", name: "present_availability_slots", args: {} }],
        }),
        new ToolMessage({
          content: JSON.stringify({ days, stepMinutes: 60 }),
          tool_call_id: "1",
          name: "present_availability_slots",
        }),
        new AIMessage("invented"),
      ],
      { days, stepMinutes: 60 },
    );
    expect(offer?.replyText).toContain("Доступні дні");
    expect(offer?.replyButtons?.[0]).toBe("10 вересня");
  });
});

describe("stabilize booking flow (DDD-48/49/50/51)", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books appointments",
    systemPrompt: "book",
    maxSteps: 8,
  };

  const snapshot: AvailabilityContext = {
    days: [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "a",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          },
          {
            id: "b",
            label: "15:00",
            dateStart: "2026-09-10T15:00:00",
            dateEnd: "2026-09-10T15:30:00",
          },
        ],
      },
    ],
    stepMinutes: 30,
    startIntervalMinutes: 30,
  };

  it("starts a direct reschedule with a fresh nearest search", async () => {
    const prepare = createAgentPrepareNode("booking");
    const rescheduleDraft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "reschedule_started",
      meeting: listedMeetings.meetings[0]!,
    });
    const seeded = await prepare(
      clinicState({
        messages: [new HumanMessage("Перенести")],
        bookingContext: listedMeetings,
        bookingDraft: rescheduleDraft,
      }),
    );
    expect(seeded.bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-1" },
      selectedDate: null,
      selectedSlot: null,
    });

    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Перенести")],
        bookingContext: listedMeetings,
        bookingDraft: seeded.bookingDraft,
        agentMessages: (seeded.agentMessages as Overwrite<AIMessage[]>).value,
      }),
    );
    const call = ((update.agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(call).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "nearest",
        excludeMeetingIds: ["m-1"],
        forceRefresh: true,
      },
    });
  });

  it("resolves date and time from one reschedule message and proceeds from the CRM slot", async () => {
    const message = new HumanMessage("Перенеси мій запис на 2026-10-16 о 14:00");
    const base = clinicState({
      messages: [message],
      bookingContext: listedMeetings,
      bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: listedMeetings.meetings[0]!,
      }),
    });
    const prepare = createAgentPrepareNode("booking");
    const seeded = await prepare(base);
    expect(seeded.bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-1" },
      selectedDate: "2026-10-16",
      requestedTime: { value: "14:00", status: "pending" },
      selectedSlot: null,
    });

    const preparedState = clinicState({
      ...base,
      bookingDraft: seeded.bookingDraft,
      agentMessages: (seeded.agentMessages as Overwrite<AIMessage[]>).value,
    });
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const lookup = await commandPrepare(preparedState);
    const lookupCall = ((lookup.agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(lookupCall).toMatchObject({
      name: "present_availability_slots",
      args: {
        direction: "exact",
        date: "2026-10-16",
        excludeMeetingIds: ["m-1"],
        forceRefresh: true,
      },
    });

    const invoked: Record<string, unknown>[] = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({
          days: [{
            date: "2026-10-16",
            slots: [{
              id: "slot-14",
              label: "14:00",
              dateStart: "2026-10-16T14:00:00",
              dateEnd: "2026-10-16T14:30:00",
            }],
          }],
          stepMinutes: 30,
          excludeMeetingIds: ["m-1"],
          query: { kind: "exact", date: "2026-10-16", coverageComplete: true },
        });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          date: z.string().optional(),
          excludeMeetingIds: z.array(z.string()).optional(),
          forceRefresh: z.boolean().optional(),
        }),
      },
    );
    const toolsUpdate = await createAgentToolsNode([slotsTool], "booking")(
      clinicState({
        ...preparedState,
        bookingDraft: seeded.bookingDraft,
        agentMessages: (lookup.agentMessages as Overwrite<AIMessage[]>).value,
      }),
      { configurable: {} },
    );
    expect(invoked[0]).toMatchObject({
      direction: "exact",
      date: "2026-10-16",
      excludeMeetingIds: ["m-1"],
      forceRefresh: true,
    });
    expect(toolsUpdate.bookingDraft).toMatchObject({
      selectedDate: "2026-10-16",
      selectedSlot: {
        dateStart: "2026-10-16T14:00:00",
        dateEnd: "2026-10-16T14:30:00",
      },
      requestedTime: null,
      phase: "ready",
    });

    const mutation = await commandPrepare(
      clinicState({
        ...preparedState,
        bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
        agentMessages: toolsUpdate.agentMessages as never,
      }),
    );
    const mutationCall = ((mutation.agentMessages as Overwrite<AIMessage[]>).value.at(-1) as AIMessage)
      .tool_calls?.[0];
    expect(mutationCall).toMatchObject({
      name: "reschedule_meeting",
      args: {
        meetingId: "m-1",
        dateStart: "2026-10-16T14:00:00",
        dateEnd: "2026-10-16T14:30:00",
      },
    });
  });

  it("records a reschedule time without entering the note step", () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: { id: "m-1" },
      }),
      { type: "date_selected", date: "2026-09-10" },
    );
    const update = advanceBookingNoteStep(
      clinicState({
        messages: [new HumanMessage("14:00")],
        bookingDraft: draft,
        availabilityContext: snapshot,
      }),
    );

    expect(update.bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(update.bookingDraft?.phase).toBe("ready");
    expect(update.bookingDraft?.note.status).toBe("unasked");
  });

  it("reports an unavailable requested time and offers the remaining CRM slots", () => {
    const finalize = createAgentFinalizeNode(agent);
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "reschedule_started",
        meeting: { id: "m-1" },
      }),
      { type: "schedule_requested", date: "2026-09-10", preferredTime: "14:00" },
    );
    const unavailable = reduceBookingDraft(draft, { type: "requested_time_unavailable" });
    const remainingAvailability: AvailabilityContext = {
      days: [{
        ...snapshot.days[0]!,
        slots: [snapshot.days[0]!.slots[1]!],
      }],
      stepMinutes: 30,
      startIntervalMinutes: 30,
    };
    const update = finalize(
      clinicState({
        bookingDraft: unavailable,
        availabilityContext: remainingAvailability,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: remainingAvailability.days,
              stepMinutes: 30,
              excludeMeetingIds: ["m-1"],
              query: { kind: "exact", date: "2026-09-10", coverageComplete: true },
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage("На жаль, цього часу немає."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("о 14:00");
    expect(update.lastHandoff?.replyText).toContain("немає вільного часу");
    expect(update.lastHandoff?.replyText).toContain("15:00");
    expect(update.lastHandoff?.replyButtons).toContain("15:00");
  });

  it("keeps consultation consent and the selected slot through note skip", async () => {
    const finalize = createAgentFinalizeNode(agent);
    const offer = finalize(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );
    expect(offer.pendingInteraction?.kind).toBe("service_confirm");
    const prepare = createAgentPrepareNode("booking");
    const picked = await prepare(
      clinicState({
        messages: [
          new HumanMessage("Записатись"),
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("14:00"),
        ],
        bookingDraft: offer.bookingDraft,
        pendingInteraction: offer.pendingInteraction,
        availabilityContext: snapshot,
      }),
    );

    expect(picked.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(picked.bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(picked.bookingDraft?.note.status).toBe("awaiting");

    const { orchestrateBookingNoteTurn } = await import("../booking-note-orchestrator.js");
    const { openVisitNoteInteraction } = await import("../booking-session.js");
    const skipped = await orchestrateBookingNoteTurn({
      patientText: "Продовжити без коментаря",
      bookingDraft: picked.bookingDraft ?? null,
      pendingInteraction: openVisitNoteInteraction(),
      classify: async () => ({ kind: "note_skipped" }),
      resolveServiceChange: async () => ({ type: "service_unresolved" }),
    });

    expect(skipped.bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(skipped.bookingDraft?.selectedSlot?.dateStart).toBe("2026-09-10T14:00:00");
    expect(skipped.bookingDraft?.note.status).toBe("skipped");
  });

  it("checkpoints a normalized mutation command before the tools node", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const draft = {
      version: 3,
      mode: "create" as const,
      phase: "details" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" as const },
      },
      availability: null,
      selectedDate: "2026-09-10",
      selectedSlot: {
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
        label: "14:00",
      },
      note: { status: "skipped" as const },
      contactId: "c-1",
      pendingCommand: null,
    };
    const update = await commandPrepare(
      clinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "c-1", firstName: "Ada", lastName: "Lovelace" }],
        },
        bookingDraft: draft,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "create-1",
              name: "create_meeting",
              args: { serviceId: "invented", dateStart: "2025-01-01T09:00:00" },
              type: "tool_call",
            }],
          }),
        ],
      }),
    );

    expect(update.bookingDraft?.pendingCommand).toMatchObject({
      action: "create",
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
  });

  it("prepares a create call from a ready draft without an LLM mutation call", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "c-1", firstName: "Ada", lastName: "Lovelace" }],
        },
        bookingDraft: {
          version: 4,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
          },
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: null,
        },
        agentMessages: [
          new ToolMessage({
            content: "{}",
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "model-create-1",
              name: "create_meeting",
              args: {},
              type: "tool_call",
            }],
          }),
        ],
      }),
    );

    const messages = (update.agentMessages as unknown as { __overwrite__?: AIMessage[] }).__overwrite__
      ?? (update.agentMessages as AIMessage[]);
    const message = messages.at(-1)!;
    expect(message.tool_calls?.[0]).toMatchObject({
      name: "create_meeting",
      args: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T14:30:00",
      },
    });
    expect(update.bookingDraft?.phase).toBe("confirming");
    expect(update.bookingDraft?.pendingCommand).toMatchObject({
      action: "create",
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
      },
    });
    expect(update.bookingDraft?.pendingCommand).not.toHaveProperty("idempotencyKey");
  });

  it("does not replay a frozen create from awaitingConfirmation (affirm uses confirmed resume)", async () => {
    // NL affirm is classified in the adapter against mutation_confirm and
    // resumes { confirmed: true }. awaitingConfirmation means chat-other only.
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const originalPayload = {
      name: "Видалення бородавки 1 шт - Test Patient",
      dateStart: "2026-10-10T11:00:00",
      dateEnd: "2026-10-10T11:30:00",
      contactId: "c-1",
      serviceId: "svc-wart",
      confirmMessage: "Підтвердити запис на 11:00?",
      description: "Видалення бородавки на ступні у сина, 11 років.",
    };
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Так, підтверджую!")],
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        bookingDraft: {
          ...canonicalBookingDraft({ contactId: "c-1" }),
          phase: "confirming",
          pendingCommand: { action: "create", payload: originalPayload },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "Так, підтверджую!",
              draft: {
                command: {
                  action: "create",
                  payload: {
                    name: originalPayload.name,
                    dateStart: originalPayload.dateStart,
                    dateEnd: originalPayload.dateEnd,
                    parentId: "c-1",
                  },
                },
              },
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(update.agentMessages).toBeUndefined();
  });

  it("does not replay a pending mutation for a non-affirmative chat reply", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("А можна інший час?")],
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: { serviceId: "svc-1", dateStart: "2026-09-10T14:00:00" },
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(update.agentMessages).toBeUndefined();
  });

  it("re-arms cancel HITL after cancel chat-other once the model answered", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const state = clinicState({
      messages: [new HumanMessage("скільки коштує консультація")],
      bookingContext: listedMeetings,
      bookingDraft: {
        ...createEmptyBookingDraft("create"),
        phase: "confirming",
        pendingCommand: null,
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
        new ToolMessage({
          content: JSON.stringify({
            awaitingConfirmation: true,
            userReply: "скільки коштує консультація",
          }),
          name: "cancel_meeting",
          tool_call_id: "cancel-1",
        }),
        new AIMessage("Вартість первинної консультації становить 300 грн."),
      ],
    });

    expect(routeAfterAgentLlm(
      state,
      8,
      "booking__tools",
      "booking__finalize",
      "booking__command_prepare",
    )).toBe("booking__command_prepare");

    const update = await commandPrepare(state);
    const messages = (update.agentMessages as Overwrite<AIMessage[]>).value;
    const lastAi = [...messages].reverse().find((message) => message instanceof AIMessage);
    expect(lastAi).toBeInstanceOf(AIMessage);
    expect(lastAi?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: expect.objectContaining({
        meetingId: "m-1",
        confirmMessage: expect.stringContaining("Скасувати"),
      }),
    });
    expect(lastAi?.tool_calls?.[0]?.args).not.toHaveProperty("confirmationGiven");
    expect(update.pendingInteraction).toMatchObject({
      kind: "mutation_confirm",
      action: "cancel",
    });
    expect(update.lastHandoff?.replyText).toBe(
      "Вартість первинної консультації становить 300 грн.",
    );
  });

  it("does not re-arm create chat-other as a mutation", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("скільки коштує консультація")],
        bookingContext: listedMeetings,
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: null,
        },
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "скільки коштує консультація",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Вартість первинної консультації становить 300 грн."),
        ],
      }),
    );
    expect(update.agentMessages).toBeUndefined();
    expect(update.lastHandoff).toBeUndefined();
  });

  it.each([undefined, true])(
    "rejects a mutation call after a non-affirmative chat reply (confirmationGiven=%s)",
    (confirmationGiven) => {
      const state = clinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              contactId: "contact-1",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            },
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage({
            content: "Не виконую дію без підтвердження.",
            tool_calls: [{
              id: "replay-1",
              name: "create_meeting",
              args: confirmationGiven === undefined ? {} : { confirmationGiven },
              type: "tool_call",
            }],
          }),
        ],
      });

      expect(routeAfterAgentLlm(state, 8, "tools", "finalize", "prepare")).toBe("finalize");
      const finalized = createAgentFinalizeNode(agent)(state);
      expect((finalized.messages as AIMessage[])[0]?.tool_calls).toHaveLength(0);
    },
  );

  it("invalidates a create slot when chat confirmation remains unresolved", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "А можна інший час?" }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Звісно, підберемо інший час."),
        ],
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      pendingCommand: null,
    });
  });

  it("does not drop the slot when keep/switch already cleared the confirm command", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          note: { status: "skipped" },
          pendingCommand: null,
        }),
        pendingInteraction: {
          kind: "service_or_note",
          currentService: { id: CONSULTATION_SERVICE_ID, name: "Консультація" },
          noteCandidate: "запиши на ботокс",
          choices: [
            { id: "keep_service", label: SERVICE_OR_NOTE_KEEP_LABEL_UK },
            { id: "switch_service", label: SERVICE_OR_NOTE_SWITCH_LABEL_UK },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на ботокс",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Ви обрали «Консультація»."),
        ],
      }),
    );

    expect(update.bookingDraft).toBeUndefined();
    expect(update.lastHandoff?.replyButtons).toEqual([
      SERVICE_OR_NOTE_KEEP_LABEL_UK,
      SERVICE_OR_NOTE_SWITCH_LABEL_UK,
    ]);
  });

  it("finalize keeps keep/switch labels in text and on the keyboard", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          phase: "confirming",
          note: { status: "skipped" },
        }),
        pendingInteraction: {
          kind: "service_or_note",
          currentService: { id: CONSULTATION_SERVICE_ID, name: "Консультація" },
          noteCandidate: "запиши на ботокс",
          choices: [
            { id: "keep_service", label: SERVICE_OR_NOTE_KEEP_LABEL_UK },
            { id: "switch_service", label: SERVICE_OR_NOTE_SWITCH_LABEL_UK },
          ],
        },
        agentMessages: [
          new AIMessage("Ви обрали «Консультація». Ваше повідомлення також може означати зміну послуги."),
        ],
      }),
    );
    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain(`• ${SERVICE_OR_NOTE_KEEP_LABEL_UK}`);
    expect(text).toContain(`• ${SERVICE_OR_NOTE_SWITCH_LABEL_UK}`);
    expect(update.lastHandoff?.replyButtons).toEqual([
      SERVICE_OR_NOTE_KEEP_LABEL_UK,
      SERVICE_OR_NOTE_SWITCH_LABEL_UK,
    ]);
  });

  const oct20SlotsTool = () =>
    new ToolMessage({
      content: JSON.stringify({
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [{
          id: "slot-20-12",
          label: "12:00",
          dateStart: "2026-10-20T12:00:00",
          dateEnd: "2026-10-20T12:30:00",
        }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2026-10-20",
          rangeFrom: "2026-10-20",
          rangeThrough: "2026-10-20",
          coverageComplete: true,
        },
      }),
      name: "present_availability_slots",
      tool_call_id: "slots-20",
    });

  const oct22SlotsTool = () =>
    new ToolMessage({
      content: JSON.stringify({
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [{
          id: "slot-22-11",
          label: "11:00",
          dateStart: "2026-10-22T11:00:00",
          dateEnd: "2026-10-22T11:30:00",
        }],
        stepMinutes: 30,
        query: {
          kind: "exact",
          date: "2026-10-22",
          rangeFrom: "2026-10-22",
          rangeThrough: "2026-10-22",
          coverageComplete: true,
        },
      }),
      name: "present_availability_slots",
      tool_call_id: "slots-22",
    });

  it("ignores pre-HITL leftover slots for TIME overlay after unresolved confirmation", () => {
    const leftover = [
      oct20SlotsTool(),
      new ToolMessage({
        content: JSON.stringify({
          awaitingConfirmation: true,
          userReply: "запиши на 22 жовтня",
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
      new AIMessage("Підберу вільні години на 22 жовтня."),
    ];
    expect(availabilityOfferFromToolTurn(leftover)).toBeNull();
    expect(resolveAvailabilityOffer(leftover, null, false)).toBeNull();
  });

  it("TIME-overlays only slots that ran after pending confirmation", () => {
    const offer = availabilityOfferFromToolTurn([
      oct20SlotsTool(),
      new ToolMessage({
        content: JSON.stringify({
          awaitingConfirmation: true,
          userReply: "запиши на 22 жовтня",
        }),
        name: "create_meeting",
        tool_call_id: "create-1",
      }),
      oct22SlotsTool(),
      new AIMessage("invented"),
    ]);
    expect(offer?.replyText).toContain("Вільні години на 22 жовтня");
    expect(offer?.replyText).not.toContain("20 жовтня");
  });

  it("does not rewrite HITL other-reply prose with leftover pre-confirm TIME", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        messages: [new HumanMessage("запиши на 22 жовтня")],
        contactContext: ownedContactContext(),
        bookingDraft: {
          ...canonicalBookingDraft({
            selectedDate: "2026-10-20",
            selectedSlot: {
              dateStart: "2026-10-20T12:00:00",
              dateEnd: "2026-10-20T12:30:00",
              label: "12:00",
            },
            phase: "confirming",
            note: { status: "answered", text: "акне" },
            pendingCommand: {
              action: "create",
              payload: {
                serviceId: "svc-1",
                dateStart: "2026-10-20T12:00:00",
                dateEnd: "2026-10-20T12:30:00",
              },
            },
          }),
        },
        agentMessages: [
          oct20SlotsTool(),
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на 22 жовтня",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
          new AIMessage("Підберу вільні години на 22 жовтня."),
        ],
      }),
    );

    const reply = (update.lastHandoff as { replyText?: string } | null)?.replyText ?? "";
    expect(reply).toContain("Підберу вільні години на 22 жовтня");
    expect(reply).not.toContain("Вільні години на 20 жовтня");
  });

  it("coerces a post-HITL exact-date slots call despite leftover pre-confirm slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00+03:00"));
    const invoke = vi.fn(async () => new AIMessage("Підберу вільні години."));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
          date: z.string().optional(),
        }),
      },
    );
    const llm = createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
    const update = await llm(
      clinicState({
        messages: [new HumanMessage("запиши на 22 жовтня")],
        contactContext: ownedContactContext(),
        bookingDraft: {
          ...canonicalBookingDraft({
            selectedDate: "2026-10-20",
            selectedSlot: {
              dateStart: "2026-10-20T12:00:00",
              dateEnd: "2026-10-20T12:30:00",
              label: "12:00",
            },
            phase: "confirming",
            note: { status: "answered", text: "акне" },
            pendingCommand: {
              action: "create",
              payload: {
                serviceId: "svc-1",
                dateStart: "2026-10-20T12:00:00",
              },
            },
          }),
        },
        agentMessages: [
          oct20SlotsTool(),
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "запиши на 22 жовтня",
            }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );
    vi.useRealTimers();

    const messages = update.agentMessages as AIMessage[];
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "present_availability_slots",
      args: { direction: "exact", date: "2026-10-22" },
    });
  });

  it("abandons a create draft after an explicit chat decline", () => {
    // Adapter maps NL decline to { confirmed: false } → cancelled tool result.
    const finalize = createAgentMutationFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: {
          ...canonicalBookingDraft(),
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ cancelled: true, message: "Patient declined." }),
            name: "create_meeting",
            tool_call_id: "create-1",
          }),
        ],
      }),
    );

    expect(update.bookingDraft).toBeNull();
    expect(update.lastHandoff?.replyText).toBe("Запис не було створено.");
  });

  it("invalidates a reschedule slot when chat confirmation remains unresolved", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        bookingDraft: {
          ...canonicalBookingDraft({
            mode: "reschedule",
            phase: "confirming",
            selectedDate: "2026-09-10",
            rescheduleTarget: { id: "meeting-1", name: "Процедура - Ada" },
            pendingCommand: {
              action: "reschedule",
              payload: { meetingId: "meeting-1", dateStart: "2026-09-10T14:00:00" },
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Покажіть інший час" }),
            name: "reschedule_meeting",
            tool_call_id: "reschedule-1",
          }),
          new AIMessage("Покажу інші вільні години."),
        ],
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      mode: "reschedule",
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      pendingCommand: null,
      rescheduleTarget: { id: "meeting-1" },
    });
  });

  it("clears direct cancellation confirmation state when chat confirmation remains unresolved", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        pendingCancellationPurpose: "direct",
        bookingDraft: {
          ...canonicalBookingDraft({
            phase: "confirming",
            serviceAcceptance: null,
            selectedDate: null,
            selectedSlot: null,
            note: { status: "unasked" },
            pendingCommand: {
              action: "cancel",
              payload: { meetingId: "meeting-1" },
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Ні, не скасовуйте" }),
            name: "cancel_meeting",
            tool_call_id: "cancel-1",
          }),
          new AIMessage("Добре, запис залишаю без змін."),
        ],
      }),
    );

    expect(update.bookingDraft).toMatchObject({
      phase: "service",
      pendingCommand: null,
    });
    expect(update.pendingCancellationPurpose).toBeNull();
  });

  it("terminates replacement cancellation when chat confirmation remains unresolved", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        pendingCancellationPurpose: "replacement",
        bookingDraft: {
          ...canonicalBookingDraft({
            mode: "replace",
            phase: "confirming",
            serviceAcceptance: null,
            selectedDate: null,
            selectedSlot: null,
            note: { status: "unasked" },
            pendingCommand: { action: "cancel", payload: { meetingId: "meeting-1" } },
            replacement: {
              meeting: { id: "meeting-1" },
              status: "cancelling",
            },
          }),
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ awaitingConfirmation: true, userReply: "Покажіть інший варіант" }),
            name: "cancel_meeting",
            tool_call_id: "cancel-1",
          }),
          new AIMessage("Не скасовую поточний запис."),
        ],
      }),
    );

    expect(update.bookingDraft).toBeNull();
    expect(update.pendingCancellationPurpose).toBeNull();
  });

  it.each(["Так", "Cancel"])(
    "dispatches cancel_meeting for replacement consent (%s)",
    async (consent) => {
      const commandPrepare = createAgentCommandPrepareNode("booking");
      const update = await commandPrepare(
        clinicState({
          messages: [new HumanMessage(consent)],
          bookingDraft: {
            version: 7,
            mode: "replace",
            phase: "confirming",
            serviceAcceptance: {
              status: "accepted",
              service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
            },
            availability: null,
            selectedDate: "2026-10-17",
            selectedSlot: {
              dateStart: "2026-10-17T11:30:00",
              dateEnd: "2026-10-17T12:00:00",
              label: "11:30",
            },
            note: { status: "skipped" },
            contactId: "c-1",
            pendingCommand: null,
            replacement: {
              meeting: { id: "existing-1", name: "Existing visit" },
              status: "offered",
              originalCommand: {
                action: "create",
                payload: { serviceId: CONSULTATION_SERVICE_ID },
                idempotencyKey: "create:replacement",
                expiresAt: Date.now() + 60_000,
              },
            },
          },
          agentMessages: [new AIMessage("Бажаєте скасувати поточний візит?")],
        }),
      );

      const messages = (update.agentMessages as unknown as { __overwrite__?: AIMessage[] }).__overwrite__
        ?? (update.agentMessages as AIMessage[]);
      expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
        name: "cancel_meeting",
        args: { meetingId: "existing-1" },
      });
      expect(update.bookingDraft?.replacement?.status).toBe("cancelling");
      expect(update.bookingDraft?.pendingCommand?.action).toBe("cancel");
    },
  );

  it("dispatches direct cancellation from the authoritative single-visit list", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingContext: listedMeetings,
        bookingDraft: {
          ...createEmptyBookingDraft(),
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "m-1", confirmMessage: "Скасувати цей візит?" },
          },
        },
        agentMessages: [new AIMessage("Запис скасовано")],
      }),
    );

    const messages = (update.agentMessages as unknown as { __overwrite__?: AIMessage[] }).__overwrite__
      ?? (update.agentMessages as AIMessage[]);
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: {
        meetingId: "m-1",
      },
    });
    expect(update.bookingDraft?.pendingCommand?.action).toBe("cancel");
    expect(update.bookingDraft?.phase).toBe("confirming");
  });

  it.each([
    "не скасовуйте",
    "як скасувати пізніше?",
    "я не хочу скасовувати",
  ])("does not synthesize cancel_meeting for non-imperative cancel phrasing (%s)", async (utterance) => {
    const state = clinicState({
      messages: [new HumanMessage(utterance)],
      bookingContext: listedMeetings,
      agentMessages: [new HumanMessage(utterance), new AIMessage("Добре")],
    });
    expect(
      routeAfterAgentLlm(
        state,
        5,
        "booking__tools",
        "booking__finalize",
        "booking__command_prepare",
      ),
    ).not.toBe("booking__command_prepare");

    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(state);
    expect(update.pendingInteraction?.kind).not.toBe("mutation_confirm");
    expect(update.bookingDraft?.pendingCommand?.action).not.toBe("cancel");
  });

  it("reuses the cancellation command for explicit chat confirmation", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingDraft: {
          version: 8,
          mode: "replace",
          phase: "confirming",
          serviceAcceptance: null,
          availability: null,
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "existing-1", confirmationGiven: true },
          },
          replacement: {
            meeting: { id: "existing-1" },
            status: "cancelling",
          },
        },
        agentMessages: [new AIMessage("Підтвердьте скасування")],
      }),
    );
    const messages = (update.agentMessages as unknown as { __overwrite__?: AIMessage[] }).__overwrite__
      ?? (update.agentMessages as AIMessage[]);
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: { meetingId: "existing-1", confirmationGiven: true },
    });
  });

  it("prepares the original create command after cancellation revalidation", async () => {
    const commandPrepare = createAgentCommandPrepareNode("booking");
    const originalCommand = {
      action: "create" as const,
      payload: {
        serviceId: CONSULTATION_SERVICE_ID,
        contactId: "c-1",
        dateStart: "2026-10-17T11:30:00",
        dateEnd: "2026-10-17T12:00:00",
      },
      idempotencyKey: "create:replacement",
      expiresAt: Date.now() + 60_000,
    };
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingContext: listedMeetings,
        bookingDraft: {
          version: 9,
          mode: "create",
          phase: "confirming",
          serviceAcceptance: {
            status: "accepted",
            service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
          },
          availability: null,
          selectedDate: "2026-10-17",
          selectedSlot: {
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
            label: "11:30",
          },
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: null,
          replacement: {
            meeting: { id: "existing-1" },
            status: "create_pending",
            originalCommand,
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              date: "2026-10-17",
              slots: [{
                label: "11:30",
                dateStart: "2026-10-17T11:30:00",
                dateEnd: "2026-10-17T12:00:00",
              }],
              stepMinutes: 30,
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage("Готую запис"),
        ],
      }),
    );
    const messages = (update.agentMessages as unknown as { __overwrite__?: AIMessage[] }).__overwrite__
      ?? (update.agentMessages as AIMessage[]);
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "create_meeting",
      args: originalCommand.payload,
    });
    expect(update.bookingDraft?.pendingCommand?.action).toBe("create");
    expect(messages.at(-1)?.tool_calls?.[0]?.name).not.toBe("cancel_meeting");
  });

  const bookingLlmReturning = (content: string) => {
    const invoke = vi.fn(async () => new AIMessage(content));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({}),
      },
    );
    return createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
  };

  it("matches clock-time picks from the availability snapshot", () => {
    expect(matchAvailabilitySlot("14:00", snapshot)?.dateStart).toBe("2026-09-10T14:00:00");
    expect(matchAvailabilitySlot("14", snapshot)?.label).toBe("14:00");
    expect(matchAvailabilitySlot(OTHER_DATE_LABEL, snapshot)).toBeNull();
    expect(matchAvailabilitySlot("Інша", snapshot)).toBeNull();
  });

  it("matches a unique bare day only inside the trusted availability snapshot", () => {
    const days: AvailabilityContext["days"] = [
      { ...snapshot.days[0]!, date: "2026-10-27", dayLabel: "27 жовтня (вівторок)" },
      { ...snapshot.days[0]!, date: "2026-10-28", dayLabel: "28 жовтня (середа)" },
    ];
    expect(matchAvailabilityDay("27", days)?.date).toBe("2026-10-27");
    expect(matchAvailabilityDay("29", days)).toBeNull();
    expect(matchAvailabilityDay("27", [
      days[0]!,
      { ...days[0]!, date: "2026-11-27", dayLabel: "27 листопада (п'ятниця)" },
    ])).toBeNull();
  });

  it("never resolves a repeated clock time from the wrong day", () => {
    const multiDaySnapshot: AvailabilityContext = {
      days: [
        {
          date: "2026-10-13",
          dayLabel: "13 жовтня (вівторок)",
          slots: [{
            id: "old",
            label: "11:30",
            dateStart: "2026-10-13T11:30:00",
            dateEnd: "2026-10-13T12:00:00",
          }],
        },
        {
          date: "2026-10-17",
          dayLabel: "17 жовтня (субота)",
          slots: [{
            id: "chosen",
            label: "11:30",
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
          }],
        },
      ],
      stepMinutes: 30,
    };
    expect(matchAvailabilitySlot("11:30", multiDaySnapshot)).toBeNull();
    expect(matchAvailabilitySlot("11:30", multiDaySnapshot, "2026-10-17")?.dateStart)
      .toBe("2026-10-17T11:30:00");
  });

  it("treats a bare hour as TIME even when another offered date has that day number", () => {
    const availability: AvailabilityContext = {
      days: [
        {
          date: "2026-10-27",
          slots: [{
            label: "11:00",
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
          }],
        },
        {
          date: "2026-11-11",
          slots: [{
            label: "12:00",
            dateStart: "2026-11-11T12:00:00",
            dateEnd: "2026-11-11T12:30:00",
          }],
        },
      ],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const update = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage("11")],
      availabilityContext: availability,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2026-10-27",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(update.bookingDraft?.selectedDate).toBe("2026-10-27");
    expect(update.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-27T11:00:00");
  });

  it("checkpoints the selected day before resolving its time", () => {
    const multiDaySnapshot: AvailabilityContext = {
      days: [
        {
          date: "2026-10-08",
          dayLabel: "8 жовтня (четвер)",
          slots: [{
            id: "old",
            label: "13:30",
            dateStart: "2026-10-08T13:30:00",
            dateEnd: "2026-10-08T14:00:00",
          }],
        },
        {
          date: "2026-10-09",
          dayLabel: "9 жовтня (пʼятниця)",
          slots: [{
            id: "chosen",
            label: "13:30",
            dateStart: "2026-10-09T13:30:00",
            dateEnd: "2026-10-09T14:00:00",
          }],
        },
      ],
      stepMinutes: 30,
    };
    const dateUpdate = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage("9 жовтня (пʼятниця)")],
      availabilityContext: multiDaySnapshot,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: null,
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(dateUpdate.bookingDraft?.selectedDate).toBe("2026-10-09");
    expect(dateUpdate.bookingDraft?.selectedSlot).toBeNull();

    const timeUpdate = advanceBookingNoteStep(clinicState({
      messages: [
        new HumanMessage("9 жовтня (пʼятниця)"),
        new HumanMessage("13:30"),
      ],
      availabilityContext: multiDaySnapshot,
      bookingDraft: canonicalBookingDraft({
        phase: "time",
        selectedDate: "2026-10-09",
        selectedSlot: null,
        note: { status: "unasked" },
      }),
    }));
    expect(timeUpdate.bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-09T13:30:00");
  });

  it("blocks a multi-day booking mutation until a validated slot exists", async () => {
    const createTool = tool(
      async () => JSON.stringify({ id: "must-not-run" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ dateStart: z.string(), dateEnd: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const update = await toolsNode(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
        }),
        availabilityContext: {
          days: [
            {
              date: "2026-10-08",
              slots: [{
                id: "a",
                label: "13:30",
                dateStart: "2026-10-08T13:30:00",
                dateEnd: "2026-10-08T14:00:00",
              }],
            },
            {
              date: "2026-10-09",
              slots: [{
                id: "b",
                label: "13:30",
                dateStart: "2026-10-09T13:30:00",
                dateEnd: "2026-10-09T14:00:00",
              }],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "create",
              name: "create_meeting",
              args: {
                dateStart: "2026-10-08T13:30:00",
                dateEnd: "2026-10-08T14:00:00",
              },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      error: "Availability slot selection required",
    });
  });

  it("advanceBookingNoteStep enters awaiting on time pick even with prior procedure talk", () => {
    const update = advanceBookingNoteStep(
      clinicState({
        messages: [new HumanMessage("губи"), new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "unasked" },
        }),
      }),
    );
    expect(update.bookingDraft?.note.status).toBe("awaiting");
    expect(update.bookingDraft?.selectedSlot?.label).toBe("14:00");
  });

  it("checkpoints bare day, bare hour, and note skip as one canonical ladder", () => {
    const availability: AvailabilityContext = {
      days: [
        {
          date: "2026-10-27",
          dayLabel: "27 жовтня (вівторок)",
          slots: [{
            id: "27-11",
            label: "11:00",
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
          }],
        },
        {
          date: "2026-10-28",
          dayLabel: "28 жовтня (середа)",
          slots: [{
            id: "28-11",
            label: "11:00",
            dateStart: "2026-10-28T11:00:00",
            dateEnd: "2026-10-28T11:30:00",
          }],
        },
      ],
      stepMinutes: 30,
      serviceId: "svc-1",
    };
    const initial = canonicalBookingDraft({
      phase: "date",
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
    });
    const dated = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage("27")],
      availabilityContext: availability,
      bookingDraft: initial,
    })).bookingDraft!;
    expect(dated.selectedDate).toBe("2026-10-27");

    const timed = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage("11")],
      availabilityContext: availability,
      bookingDraft: dated,
    })).bookingDraft!;
    expect(timed.selectedSlot?.dateStart).toBe("2026-10-27T11:00:00");
    expect(timed.note.status).toBe("awaiting");

    const skipped = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage(INTENT_SKIP_LABEL)],
      availabilityContext: availability,
      bookingDraft: timed,
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
      },
    })).bookingDraft!;
    expect(skipped.note.status).toBe("skipped");
  });

  it("advanceBookingNoteStep skips on INTENT shortcut; free text stays for the note orch", () => {
    expect(
      advanceBookingNoteStep(
        clinicState({
          messages: [new HumanMessage(INTENT_SKIP_LABEL)],
          bookingDraft: canonicalBookingDraft({
            phase: "note",
            note: { status: "awaiting" },
          }),
          availabilityContext: snapshot,
        }),
      ).bookingDraft?.note.status,
    ).toBe("skipped");
    const freeText = advanceBookingNoteStep(
      clinicState({
        messages: [new HumanMessage("хочу ботокс губ")],
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        availabilityContext: snapshot,
      }),
    );
    expect(freeText.bookingDraft).toBeUndefined();
    expect(freeText.pendingInteraction).toBeUndefined();
  });

  it("treats a new explicit date as a date change while the note prompt is visible", () => {
    const draft = {
      version: 3,
      mode: "create" as const,
      phase: "note" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: { id: CONSULTATION_SERVICE_ID, source: "catalog" as const },
      },
      availability: null,
      selectedDate: "2026-11-20",
      selectedSlot: {
        dateStart: "2026-11-20T11:00:00",
        dateEnd: "2026-11-20T11:30:00",
        label: "11:00",
      },
      note: { status: "awaiting" as const },
      contactId: null,
      pendingCommand: null,
    };
    const update = advanceBookingNoteStep(
      clinicState({
        messages: [new HumanMessage("на 21.11")],
        bookingDraft: draft,
        availabilityContext: snapshot,
      }),
    );

    expect(update.bookingDraft?.selectedDate).toBe("2026-11-21");
    expect(update.bookingDraft?.selectedSlot).toBeNull();
    expect(update.bookingDraft?.note.status).toBe("awaiting");
  });

  it("selects the trusted interval without treating legacy step metadata as duration truth", () => {
    const update = advanceBookingNoteStep(
      clinicState({
        messages: [new HumanMessage("12:30")],
        availabilityContext: {
          days: [{
            date: "2026-11-21",
            slots: [{
              id: "12:30",
              label: "12:30",
              dateStart: "2026-11-21T12:30:00",
              dateEnd: "2026-11-21T13:30:00",
            }],
          }],
          stepMinutes: 30,
          serviceId: "svc-neotiva",
        },
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "time",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
          selectedDate: "2026-11-21",
          selectedSlot: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: null,
        },
      }),
    );

    expect(update.bookingDraft?.selectedSlot?.dateEnd).toBe("2026-11-21T13:30:00");
    expect(update.bookingDraft?.note.status).toBe("awaiting");
  });

  it("DDD-48: code-owns skip-comment keyboard while note step is awaiting", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        agentMessages: [
          new AIMessage("Чи можете поділитися деталями перед записом?"),
        ],
      }),
    );
    expect(update.lastHandoff?.replyButtons).toEqual([INTENT_SKIP_LABEL]);
    // Already awaiting: finalize does not rewrite the note aggregate.
    expect(update.bookingDraft).toBeUndefined();
  });

  it("DDD-49/51: blocks create_meeting before HITL and forces note ask + skip keyboard", async () => {
    const createTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).error).toBe("Note step required");
    expect(toolsUpdate.bookingDraft?.note.status).toBe("awaiting");

    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 2,
        bookingDraft: canonicalBookingDraft({
          phase: "note",
          note: { status: "awaiting" },
        }),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
          toolMsg,
          new AIMessage(""),
        ],
      }),
    );
    expect(update.lastHandoff?.replyText).toBe(BOOKING_NOTE_QUESTION_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([INTENT_SKIP_LABEL]);
  });

  it("recovers a premature note-guarded create from canonical availability without another model call", async () => {
    const invoke = vi.fn(async () => new AIMessage("should not run"));
    const llm = createAgentLlmNode({
      agent,
      model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
      tools: [],
      formatSystemMetadata: () => "DYN",
    });
    const guard = new ToolMessage({
      content: JSON.stringify({ error: "Note step required" }),
      tool_call_id: "c1",
      name: "create_meeting",
    });
    const availability: AvailabilityContext = {
      days: [
        {
          date: "2026-10-27",
          dayLabel: "27 жовтня (вівторок)",
          slots: [{
            label: "11:00",
            dateStart: "2026-10-27T11:00:00",
            dateEnd: "2026-10-27T11:30:00",
          }],
        },
        {
          date: "2026-10-28",
          dayLabel: "28 жовтня (середа)",
          slots: [{
            label: "12:00",
            dateStart: "2026-10-28T12:00:00",
            dateEnd: "2026-10-28T12:30:00",
          }],
        },
      ],
      stepMinutes: 30,
    };
    const state = clinicState({
      stepCount: 1,
      bookingDraft: canonicalBookingDraft({
        phase: "date",
        selectedDate: null,
        selectedSlot: null,
        note: { status: "unasked" },
      }),
      availabilityContext: availability,
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
        }),
        guard,
      ],
    });
    const llmUpdate = await llm(state);
    expect(invoke).not.toHaveBeenCalled();

    const update = createAgentFinalizeNode(agent)(clinicState({
      ...state,
      agentMessages: [
        ...state.agentMessages,
        ...(llmUpdate.agentMessages as AIMessage[]),
      ],
      stepCount: llmUpdate.stepCount,
    }));
    expect(update.lastHandoff?.replyText).toContain("Доступні дні");
    expect(update.lastHandoff?.replyText).not.toBe(BOOKING_NOTE_QUESTION_UK);
    expect(update.lastHandoff?.replyButtons).toEqual(["27 жовтня", "28 жовтня", OTHER_DATE_LABEL]);
  });

  it("blocks create_meeting with consultation id without explicit agreement", async () => {
    const createTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("запиши на ботулінотерапію"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  serviceId: CONSULTATION_SERVICE_ID,
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).error).toBe("Consultation agreement required");
  });

  it("allows create_meeting with consultation id after Так to consultation offer", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        contactContext: ownedContactContext(),
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "date",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: CONSULTATION_SERVICE_ID,
              name: "Консультація",
              source: "catalog",
            },
          },
          availability: null,
          selectedDate: null,
          selectedSlot: null,
          note: { status: "skipped" },
          contactId: "contact-1",
          pendingCommand: null,
        },
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("Так"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  serviceId: CONSULTATION_SERVICE_ID,
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(JSON.parse(String((toolsUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      awaitingConfirmation: true,
    });
  });

  it("captures the existing meeting when create_meeting reports Already booked", async () => {
    const createTool = tool(
      async () => JSON.stringify({
        error: "Already booked",
        meetings: [{
          id: "existing-1",
          name: "Консультація - Ada",
          dateStart: "2026-09-10 11:00:00",
          dateEnd: "2026-09-10 11:30:00",
        }],
      }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext("c-1"),
        availabilityContext: snapshot,
        bookingDraft: {
          version: 3,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", source: "catalog" },
          },
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "skipped" },
          contactId: "c-1",
          pendingCommand: {
            action: "create",
            payload: { serviceId: "svc-1" },
            idempotencyKey: "create:original",
            expiresAt: Date.now() + 60_000,
          },
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              date: "2026-09-10",
              slots: [{
                label: "14:00",
                dateStart: "2026-09-10T14:00:00",
                dateEnd: "2026-09-10T14:30:00",
              }],
              stepMinutes: 30,
            }),
            name: "present_availability_slots",
            tool_call_id: "revalidate-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "create-1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.bookingDraft?.replacement).toMatchObject({
      status: "offered",
      meeting: { id: "existing-1", name: "Консультація - Ada" },
      originalCommand: { idempotencyKey: "create:original" },
    });
  });

  it("records catalog consultation selection before accepting a generic procedure offer", async () => {
    const prepare = createAgentPrepareNode("booking");
    const prepared = await prepare(clinicState({
      messages: [
        new HumanMessage("Консультація первинна"),
        new AIMessage("Бажаєте записатися на цю процедуру?"),
        new HumanMessage("Так"),
      ],
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
      lastHandoff: {
        agentId: "faq",
        agentName: "FAQ",
        status: "ok",
        replyText: "Бажаєте записатися на цю процедуру?",
      },
    }));

    expect(prepared.bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
    });

    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        ...prepared,
        contactContext: ownedContactContext(),
        bookingDraft: {
          ...prepared.bookingDraft!,
          phase: "details",
          note: { status: "skipped" },
          selectedDate: "2026-10-17",
          selectedSlot: {
            dateStart: "2026-10-17T11:30:00",
            dateEnd: "2026-10-17T12:00:00",
            label: "11:30",
          },
          contactId: "contact-1",
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "catalog-consent",
              name: "create_meeting",
              args: { serviceId: CONSULTATION_SERVICE_ID },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(JSON.parse(String((toolsUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      awaitingConfirmation: true,
    });
  });

  it("blocks reschedule_meeting with consultation id without explicit agreement", async () => {
    const rescheduleTool = tool(
      async () => JSON.stringify({ id: "should-not-run" }),
      {
        name: "reschedule_meeting",
        description: "reschedule",
        schema: z.object({ serviceId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([rescheduleTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        messages: [
          new AIMessage("Підібрати вільний час на консультацію?"),
          new HumanMessage("запиши на ботулінотерапію"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "r1",
                name: "reschedule_meeting",
                args: {
                  serviceId: CONSULTATION_SERVICE_ID,
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).error).toBe("Consultation agreement required");
  });

  it("allows create_meeting after note step is skipped", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const toolsUpdate = await toolsNode(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).awaitingConfirmation).toBe(true);
  });

  it("keeps the frozen tool arguments when HITL returns a chat confirmation", async () => {
    const createTool = tool(
      async () => JSON.stringify({
        awaitingConfirmation: true,
        userReply: "Так",
        draft: {
          command: {
            action: "create",
            payload: { parentId: "c-1", status: "Planned" },
          },
        },
      }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const originalPayload = {
      name: "Процедура - Ada Lovelace",
      dateStart: "2026-09-10T14:00:00",
      dateEnd: "2026-09-10T14:30:00",
      contactId: "c-1",
      serviceId: "svc-1",
      confirmMessage: "Підтвердити запис?",
      description: "Короткий коментар.",
    };
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext("c-1"),
        availabilityContext: snapshot,
        bookingDraft: canonicalBookingDraft({
          contactId: "c-1",
          phase: "confirming",
          pendingCommand: { action: "create", payload: originalPayload },
        }),
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify(snapshot),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "create-1",
              name: "create_meeting",
              args: originalPayload,
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(update.bookingDraft?.pendingCommand).toEqual({
      action: "create",
      payload: originalPayload,
    });
  });

  it("fails closed when create follows an unsuccessful slot revalidation", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          phase: "confirming",
          pendingCommand: { action: "create", payload: { serviceId: "svc-1" } },
        }),
        availabilityContext: snapshot,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({ error: "CRM unavailable" }),
            name: "present_availability_slots",
            tool_call_id: "revalidate-1",
          }),
          new AIMessage({
            content: "",
            tool_calls: [{ id: "create-1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    const toolMsg = (toolsUpdate.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).error).toBe("Selected slot is no longer available");
  });

  it("rejects a selected interval whose end does not match the service snapshot", async () => {
    const createTool = tool(
      async () => JSON.stringify({ awaitingConfirmation: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsUpdate = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: {
          version: 2,
          mode: "create",
          phase: "details",
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
          availability: null,
          selectedDate: "2026-11-21",
          selectedSlot: {
            slotId: "12:30",
            dateStart: "2026-11-21T12:30:00",
            dateEnd: "2026-11-21T13:00:00",
            label: "12:30",
          },
          note: { status: "skipped" },
          contactId: "contact-1",
          pendingCommand: null,
        },
        availabilityContext: {
          serviceId: "svc-neotiva",
          stepMinutes: 60,
          days: [{
            date: "2026-11-21",
            slots: [{
              id: "12:30",
              label: "12:30",
              dateStart: "2026-11-21T12:30:00",
              dateEnd: "2026-11-21T13:30:00",
            }],
          }],
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "mismatch",
              name: "create_meeting",
              args: {},
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(
      JSON.parse(String((toolsUpdate.agentMessages as ToolMessage[])[0]!.content)).error,
    ).toBe("Selected slot is no longer available");
  });

  it("DDD-50: HITL decline clears availability so next slots call is CRM", async () => {
    const createTool = tool(
      async () => JSON.stringify({ cancelled: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const declineUpdate = await toolsNode(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft(),
        availabilityContext: snapshot,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(JSON.parse(String((declineUpdate.agentMessages as ToolMessage[])[0]!.content))).toEqual({
      cancelled: true,
    });
    expect(declineUpdate.availabilityContext).toBeNull();
    expect(declineUpdate.bookingDraft?.selectedSlot).toBeNull();
    expect(declineUpdate.bookingDraft?.note.status).toBe("skipped");
  });

  it("preserves service duration after declined booking before an other-date search", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const createTool = tool(
      async () => JSON.stringify({ cancelled: true }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({
          days: [],
          stepMinutes: input.durationMinutes,
          query: {
            kind: "later",
            rangeFrom: "2026-10-06",
            rangeThrough: "2026-11-04",
            coverageComplete: true,
          },
        });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
          durationMinutes: z.number().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool, slotsTool], "booking");
    const draft = {
      version: 1,
      mode: "create" as const,
      phase: "confirming" as const,
      serviceAcceptance: {
        status: "accepted" as const,
        service: {
          id: "svc-long",
          name: "Long procedure",
          durationMinutes: 60,
          source: "catalog" as const,
        },
      },
      selectedDate: "2026-09-10",
      selectedSlot: {
        dateStart: "2026-09-10T14:00:00",
        dateEnd: "2026-09-10T15:00:00",
        label: "14:00",
      },
      note: { status: "skipped" as const },
      contactId: "contact-1",
      pendingCommand: null,
      replacement: null,
    };
    const declineUpdate = await toolsNode(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: draft,
        availabilityContext: {
          ...snapshot,
          stepMinutes: 60,
          days: [{
            ...snapshot.days[0]!,
            slots: [{
              ...snapshot.days[0]!.slots[0]!,
              dateEnd: "2026-09-10T15:00:00",
            }],
          }],
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "create-1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(declineUpdate.bookingDraft?.serviceAcceptance?.service.durationMinutes).toBe(60);
    expect(declineUpdate.bookingDraft?.selectedSlot).toBeNull();
    expect(declineUpdate.bookingDraft?.note.status).toBe("skipped");

    await toolsNode(
      clinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        bookingDraft: declineUpdate.bookingDraft,
        availabilityContext: null,
        availabilityCursor: null,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "slots-1",
              name: "present_availability_slots",
              args: { direction: "later" },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({
      direction: "later",
      durationMinutes: 60,
    });
  });

  it("REPLACE cancel commit nulls availability but keeps selectedSlot and note", async () => {
    const cancelTool = tool(
      async () => JSON.stringify({ success: true, id: "m-1" }),
      {
        name: "cancel_meeting",
        description: "cancel",
        schema: z.object({ meetingId: z.string() }),
      },
    );
    const toolsNode = createAgentToolsNode([cancelTool], "booking");
    const update = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        availabilityContext: snapshot,
        selectedSlot: {
          dateStart: "2026-09-29T12:00:00",
          dateEnd: "2026-09-29T13:00:00",
          label: "12:00",
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "cancel_meeting",
                args: { meetingId: "m-1" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
  });

  it("committed create_meeting still resets selectedSlot and note", async () => {
    const createTool = tool(
      async () => JSON.stringify({ success: true, id: "m-new" }),
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({}),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    const update = await toolsNode(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
        }),
        availabilityContext: snapshot,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(update.availabilityContext).toBeNull();
    expect(update.bookingDraft).toBeNull();
  });

  it("serves checkpointed slots on cache hit without invoking CRM tool", async () => {
    let crmCalls = 0;
    const slotsTool = tool(
      async () => {
        crmCalls += 1;
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    const update = await toolsNode(
      clinicState({
        availabilityContext: snapshot,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { durationMinutes: 30 },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(crmCalls).toBe(0);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    const body = JSON.parse(String(toolMsg.content)) as {
      days: unknown[];
      cacheHit: boolean;
    };
    expect(body.cacheHit).toBe(true);
    expect(body.days).toHaveLength(1);
    expect(update.availabilityContext?.days).toHaveLength(1);
  });

  it.each([
    { label: OTHER_DATE_LABEL, llmAfter: "2025-10-05" },
    { label: OTHER_DATE_LABEL_EN, llmAfter: "2025-10-05" },
    { label: "Інша", llmAfter: undefined },
  ])(
    "rewrites afterDate from checkpoint on other-date ($label)",
    async ({ label, llmAfter }) => {
      const multiDay: AvailabilityContext = {
        days: [
          snapshot.days[0]!,
          {
            date: "2026-10-05",
            dayLabel: "5 жовтня (понеділок)",
            slots: [
              {
                id: "c",
                label: "11:00",
                dateStart: "2026-10-05T11:00:00",
                dateEnd: "2026-10-05T11:30:00",
              },
            ],
          },
        ],
        stepMinutes: 30,
      };
      const invoked: Array<Record<string, unknown>> = [];
      const slotsTool = tool(
        async (input: Record<string, unknown>) => {
          invoked.push(input);
          return JSON.stringify({
            days: [
              {
                date: "2026-10-06",
                dayLabel: "6 жовтня (вівторок)",
                slots: [
                  {
                    id: "d",
                    label: "11:00",
                    dateStart: "2026-10-06T11:00:00",
                    dateEnd: "2026-10-06T11:30:00",
                  },
                ],
              },
            ],
            stepMinutes: 30,
          });
        },
        {
          name: "present_availability_slots",
          description: "slots",
          schema: z.object({
            durationMinutes: z.number().optional(),
            date: z.string().optional(),
            afterDate: z.string().optional(),
          }),
        },
      );
      const toolsNode = createAgentToolsNode([slotsTool], "booking");
      const update = await toolsNode(
        clinicState({
          messages: [new HumanMessage(label)],
          availabilityContext: multiDay,
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "s1",
                  name: "present_availability_slots",
                  args: {
                    durationMinutes: 30,
                    ...(llmAfter ? { afterDate: llmAfter } : {}),
                    date: "2026-09-10",
                  },
                  type: "tool_call",
                },
              ],
            }),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toHaveLength(1);
      expect(invoked[0]).toEqual({ durationMinutes: 30, afterDate: "2026-10-05" });
      expect(update.availabilityContext?.days[0]?.date).toBe("2026-10-06");
    },
  );

  it("rewrites create_meeting dateStart/dateEnd from selectedSlot when the model invents the year", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const createTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ awaitingConfirmation: true });
      },
      {
        name: "create_meeting",
        description: "create",
        schema: z.object({
          dateStart: z.string(),
          dateEnd: z.string(),
          serviceId: z.string(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([createTool], "booking");
    await toolsNode(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          selectedDate: "2026-10-13",
          selectedSlot: {
            dateStart: "2026-10-13T11:00:00",
            dateEnd: "2026-10-13T12:00:00",
            label: "11:00",
          },
        }),
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "create_meeting",
                args: {
                  serviceId: "svc-1",
                  dateStart: "2025-10-13T11:00:00",
                  dateEnd: "2025-10-13T12:00:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.dateStart).toBe("2026-10-13T11:00:00");
    expect(invoked[0]?.dateEnd).toBe("2026-10-13T12:00:00");
  });

  it("aligns present_availability_slots date year to the snapshot so TIME cache can hit", async () => {
    const oct13: AvailabilityContext = {
      days: [
        {
          date: "2026-10-13",
          dayLabel: "13 жовтня (вівторок)",
          slots: [
            {
              id: "a",
              label: "14:00",
              dateStart: "2026-10-13T14:00:00",
              dateEnd: "2026-10-13T15:00:00",
            },
          ],
        },
      ],
      stepMinutes: 60,
      startIntervalMinutes: 30,
    };
    let crmCalls = 0;
    const slotsTool = tool(
      async () => {
        crmCalls += 1;
        return JSON.stringify({ days: [], stepMinutes: 60 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("13 жовтня")],
        availabilityContext: oct13,
        agentMessages: [
          new HumanMessage("13 жовтня"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { durationMinutes: 60, date: "2025-10-13" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(crmCalls).toBe(0);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    const body = JSON.parse(String(toolMsg.content)) as { date: string; cacheHit: boolean };
    expect(body.cacheHit).toBe(true);
    expect(body.date).toBe("2026-10-13");
  });

  it("drops an invalid model-only date and searches nearest before CRM", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { durationMinutes: 30, date: "not-a-date" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ direction: "nearest", durationMinutes: 30 }]);
  });

  it("rejects reschedule_meeting with invalid dateStart after align", async () => {
    let invoked = 0;
    const rescheduleTool = tool(
      async () => {
        invoked += 1;
        return JSON.stringify({ awaitingConfirmation: true });
      },
      {
        name: "reschedule_meeting",
        description: "reschedule",
        schema: z.object({
          meetingId: z.string(),
          dateStart: z.string(),
          dateEnd: z.string(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([rescheduleTool], "booking");
    const update = await toolsNode(
      clinicState({
        bookingNoteStatus: "skipped",
        availabilityContext: snapshot,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "r1",
                name: "reschedule_meeting",
                args: {
                  meetingId: "m-1",
                  dateStart: "not-a-datetime",
                  dateEnd: "2026-09-10T15:00:00",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toBe(0);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content))).toMatchObject({
      error: "Invalid meeting datetime",
    });
  });

  it("hydrates TIME «Інша дата» XML into slots tool_calls and pages from last snapshot day", async () => {
    const { createAgentLlmNode } = await import("../agent-loop.js");
    const leaked =
      "<call:default_api:present_availability_slots{afterDate: 2026-09-29,durationMinutes:30}></call:default_api:present_availability_slots>";
    const invoke = vi.fn(async () => new AIMessage(leaked));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const llm = createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
    const timeViewSnapshot: AvailabilityContext = {
      days: [
        {
          date: "2026-09-29",
          dayLabel: "29 вересня (вівторок)",
          slots: [
            {
              id: "a",
              label: "11:00",
              dateStart: "2026-09-29T11:00:00",
              dateEnd: "2026-09-29T11:30:00",
            },
          ],
        },
        {
          date: "2026-10-01",
          dayLabel: "1 жовтня (четвер)",
          slots: [
            {
              id: "b",
              label: "11:00",
              dateStart: "2026-10-01T11:00:00",
              dateEnd: "2026-10-01T11:30:00",
            },
          ],
        },
        {
          date: "2026-10-02",
          dayLabel: "2 жовтня (п'ятниця)",
          slots: [
            {
              id: "c",
              label: "11:00",
              dateStart: "2026-10-02T11:00:00",
              dateEnd: "2026-10-02T11:30:00",
            },
          ],
        },
      ],
      stepMinutes: 30,
    };
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        agentMessages: [new HumanMessage(OTHER_DATE_LABEL)],
        availabilityContext: timeViewSnapshot,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(String(ai.content)).not.toContain("call:default_api");
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: { afterDate: "2026-09-29", durationMinutes: 30 },
      }),
    ]);

    const invoked: Array<Record<string, unknown>> = [];
    const runSlotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([runSlotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        availabilityContext: timeViewSnapshot,
        agentMessages: llmUpdate.agentMessages as never,
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ afterDate: "2026-10-02", durationMinutes: 30 }]);
  });

  it("ignores leaked Gemini XML for tools not bound to the agent", async () => {
    const { createAgentLlmNode } = await import("../agent-loop.js");
    const leaked =
      "<call:default_api:create_meeting{serviceId: demo}></call:default_api:create_meeting>";
    const invoke = vi.fn(async () => new AIMessage(leaked));
    const slotsTool = tool(
      async () => JSON.stringify({ days: [], stepMinutes: 30 }),
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({}),
      },
    );
    const llm = createAgentLlmNode({
      agent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [slotsTool],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage("ok")],
        agentMessages: [new HumanMessage("ok")],
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(String(ai.content)).not.toContain("call:default_api");
    expect(ai.tool_calls ?? []).toEqual([]);
  });

  it("strips native tool_calls for tools not bound to the agent", async () => {
    const { createAgentLlmNode } = await import("../agent-loop.js");
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers questions",
      systemPrompt: "faq",
      maxSteps: 8,
    };
    const readTool = tool(async () => "ok", {
      name: "list_services",
      description: "services",
      schema: z.object({}),
    });
    const invoke = vi.fn(async () =>
      new AIMessage({
        content: "Ось каталог послуг.",
        tool_calls: [
          {
            id: "stale_faq_catalog",
            name: "faq_catalog_action",
            args: { action: "keep_catalog" },
            type: "tool_call",
          },
        ],
      }),
    );
    const llm = createAgentLlmNode({
      agent: faqAgent,
      model: { bindTools: vi.fn(() => ({ invoke })) } as unknown as BaseChatModel,
      tools: [readTool],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage("Послуги")],
        agentMessages: [new HumanMessage("Послуги")],
        next: "faq",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls ?? []).toEqual([]);
    expect(String(ai.content)).toBe("Ось каталог послуг.");
  });

  it("injects present_availability_slots when DATE copy has no tool_calls", async () => {
    const llm = bookingLlmReturning(formatAvailabilityDateOffer(snapshot.days).replyText);
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage("Так")],
        agentMessages: [new HumanMessage("Так")],
        availabilityContext: null,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: { direction: "nearest" },
      }),
    ]);
  });

  it("forces availability lookup for direct reschedule instead of accepting a day prompt", async () => {
    const llm = bookingLlmReturning("Оберіть новий день для перенесення візиту:");
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage("Перенести")],
        agentMessages: [new HumanMessage("Перенести")],
        bookingContext: listedMeetings,
        bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
          type: "reschedule_started",
          meeting: listedMeetings.meetings[0]!,
        }),
        availabilityContext: null,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: {
          direction: "nearest",
          excludeMeetingIds: ["m-1"],
        },
      }),
    ]);
  });

  it("starts a fresh nearest search after accepting a consultation offer", async () => {
    const llm = bookingLlmReturning("Добре");
    const state = clinicState({
      messages: [new HumanMessage("Так")],
      agentMessages: [new HumanMessage("Так")],
      availabilityContext: {
        ...snapshot,
        searchDirection: "exact",
        searchAnchor: "2026-10-08",
        query: {
          kind: "exact",
          date: "2026-10-08",
          rangeFrom: "2026-10-08",
          rangeThrough: "2026-10-08",
          coverageComplete: true,
        },
      },
      lastHandoff: {
        agentId: "booking",
        agentName: "Booking",
        status: "ok",
        replyText: "Підібрати вільний час на консультацію?",
        replyButtons: ["Так", "Обрати іншу процедуру"],
      },
      next: "booking",
    });

    const llmUpdate = await llm(state);
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: { direction: "nearest" },
      }),
    ]);
  });

  it("does not carry an exact cursor when the model calls availability after consultation acceptance", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          afterDate: z.string().optional(),
          date: z.string().optional(),
          durationMinutes: z.number().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("Так")],
        availabilityContext: {
          ...snapshot,
          searchDirection: "exact",
          searchAnchor: "2026-10-08",
        },
        lastHandoff: {
          agentId: "booking",
          agentName: "Booking",
          status: "ok",
          replyText: "Підібрати вільний час на консультацію?",
        },
        agentMessages: [
          new HumanMessage("Так"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { direction: "later", afterDate: "2026-10-08", durationMinutes: 30 },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ direction: "nearest", durationMinutes: 30 }]);
  });

  it.each([OTHER_DATE_LABEL, "другая дата", "другая", "другой"])(
    "injects present_availability_slots for alternative-date reply %s when TIME has no tool_calls",
    async (otherDateReply) => {
    const llm = bookingLlmReturning("Добре");
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage(otherDateReply)],
        agentMessages: [new HumanMessage(otherDateReply)],
        availabilityContext: snapshot,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls).toEqual([
      expect.objectContaining({
        name: "present_availability_slots",
        args: { direction: "later" },
      }),
    ]);
    },
  );

  it("injects the validated exact date when the model skips the availability tool", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T09:00:00Z"));
      const llm = bookingLlmReturning("На 20 жовтня вільного часу немає.");
      const llmUpdate = await llm(
        clinicState({
          messages: [new HumanMessage("20 жовтня")],
          agentMessages: [new HumanMessage("20 жовтня")],
          availabilityContext: snapshot,
          next: "booking",
        }),
      );
      const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
      expect(ai.tool_calls).toEqual([
        expect.objectContaining({
          name: "present_availability_slots",
          args: { direction: "exact", date: "2026-10-20" },
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors a bare day to the current booking month before model prose can invent slots", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-28T09:00:00Z"));
      const llm = bookingLlmReturning("На 26 жовтня вільного часу немає.");
      const llmUpdate = await llm(
        clinicState({
          messages: [new HumanMessage("26")],
          agentMessages: [new HumanMessage("26")],
          availabilityContext: {
            days: [{ date: "2026-10-25", slots: [] }],
            stepMinutes: 30,
            query: {
              kind: "exact",
              date: "2026-10-25",
              rangeFrom: "2026-10-25",
              rangeThrough: "2026-10-25",
              coverageComplete: true,
            },
          },
          bookingDraft: canonicalBookingDraft({
            phase: "time",
            selectedDate: "2026-10-25",
            selectedSlot: null,
            note: { status: "unasked" },
          }),
          next: "booking",
        }),
      );
      const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
      expect(ai.tool_calls).toEqual([
        expect.objectContaining({
          name: "present_availability_slots",
          args: { direction: "exact", date: "2026-10-26" },
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overrides a model-supplied stale date with the patient request before CRM", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-24T09:00:00Z"));
      const invoked: Array<Record<string, unknown>> = [];
      const slotsTool = tool(
        async (input: Record<string, unknown>) => {
          invoked.push(input);
          return JSON.stringify({ days: [], stepMinutes: 30 });
        },
        {
          name: "present_availability_slots",
          description: "slots",
          schema: z.object({
            direction: z.string().optional(),
            date: z.string().optional(),
            durationMinutes: z.number().optional(),
          }),
        },
      );
      const toolsNode = createAgentToolsNode([slotsTool], "booking");
      await toolsNode(
        clinicState({
          messages: [new HumanMessage("20 жовтня")],
          availabilityContext: snapshot,
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [
                {
                  id: "stale-date",
                  name: "present_availability_slots",
                  args: { direction: "nearest", date: "2025-10-20", durationMinutes: 30 },
                  type: "tool_call",
                },
              ],
            }),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toEqual([
        { direction: "exact", date: "2026-10-20", durationMinutes: 30 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a stale model date for a nearest search", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          date: z.string().optional(),
          durationMinutes: z.number().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("найближча дата")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "nearest-stale-date",
              name: "present_availability_slots",
              args: { direction: "nearest", date: "2025-10-20", durationMinutes: 30 },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ direction: "nearest", durationMinutes: 30 }]);
  });

  it("does not re-inject slots after «Інша дата» already paged this turn", async () => {
    const llm = bookingLlmReturning(formatAvailabilityDateOffer(snapshot.days).replyText);
    const llmUpdate = await llm(
      clinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        agentMessages: [
          new HumanMessage(OTHER_DATE_LABEL),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { afterDate: "2026-09-10", durationMinutes: 30 },
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({
              days: snapshot.days,
              stepMinutes: 30,
            }),
            tool_call_id: "s1",
            name: "present_availability_slots",
          }),
        ],
        availabilityContext: snapshot,
        next: "booking",
      }),
    );
    const ai = (llmUpdate.agentMessages as AIMessage[])[0]!;
    expect(ai.tool_calls ?? []).toEqual([]);
  });

  it("does not page CRM again on a second «Інша дата» slots call this turn", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage(OTHER_DATE_LABEL)],
        availabilityContext: snapshot,
        agentMessages: [
          new HumanMessage(OTHER_DATE_LABEL),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { durationMinutes: 30, afterDate: "2026-09-10" },
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            content: JSON.stringify({ days: snapshot.days, stepMinutes: 30 }),
            tool_call_id: "s1",
            name: "present_availability_slots",
          }),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s2",
                name: "present_availability_slots",
                args: { durationMinutes: 30, afterDate: "2026-09-10" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    const body = JSON.parse(String(toolMsg.content)) as {
      days: Array<{ date: string }>;
      cacheHit: boolean;
    };
    expect(body.cacheHit).toBe(true);
    expect(body.days[0]?.date).toBe("2026-09-10");
  });

  it("does not rewrite afterDate for «Інша процедура»", async () => {
    let crmCalls = 0;
    const slotsTool = tool(
      async () => {
        crmCalls += 1;
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          afterDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Інша процедура")],
        availabilityContext: snapshot,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: { durationMinutes: 30 },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(crmCalls).toBe(0);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content)).cacheHit).toBe(true);
  });

  it("pages later for Russian «другая» from the empty snapshot date instead of dropping the boundary", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
          afterDate: z.string().optional(),
          startDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("другая")],
        availabilityContext: {
          days: [
            {
              date: "2026-10-05",
              dayLabel: "5 жовтня (понеділок)",
              slots: [],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          new HumanMessage("другая"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: {
                  durationMinutes: 30,
                  afterDate: "2025-10-05",
                  date: "2026-10-01",
                  startDate: "2026-09-11",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ afterDate: "2026-10-05", durationMinutes: 30 }]);
  });

  it("keeps a patient-named date when there is no availability snapshot", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          durationMinutes: z.number().optional(),
          date: z.string().optional(),
          afterDate: z.string().optional(),
          startDate: z.string().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("20 жовтня")],
        availabilityContext: null,
        agentMessages: [
          new HumanMessage("20 жовтня"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "s1",
                name: "present_availability_slots",
                args: {
                  durationMinutes: 30,
                  afterDate: "2025-10-05",
                  date: "2026-10-20",
                  startDate: "2026-09-11",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      { durationMinutes: 30, date: "2026-10-20" },
    ]);
  });

  it("uses the durable cursor after the availability snapshot expires", async () => {
    const invoked: Array<Record<string, unknown>> = [];
    const slotsTool = tool(
      async (input: Record<string, unknown>) => {
        invoked.push(input);
        return JSON.stringify({ days: [], stepMinutes: 30 });
      },
      {
        name: "present_availability_slots",
        description: "slots",
        schema: z.object({
          direction: z.string().optional(),
          afterDate: z.string().optional(),
          durationMinutes: z.number().optional(),
        }),
      },
    );
    const toolsNode = createAgentToolsNode([slotsTool], "booking");
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("другая")],
        availabilityContext: null,
        availabilityCursor: {
          direction: "later",
          searchedThrough: "2026-10-05",
          firstDate: "2026-09-29",
          lastDate: "2026-10-05",
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "s1",
              name: "present_availability_slots",
              args: { direction: "later", durationMinutes: 30 },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      { direction: "later", afterDate: "2026-10-05", durationMinutes: 30 },
    ]);
  });

  it("DATE keyboard attaches on cache-hit tool turn; date prose without tool gets no DATE chips", () => {
    const finalize = createAgentFinalizeNode(agent);
    const withTool = finalize(
      clinicState({
        stepCount: 2,
        availabilityContext: {
          days: [
            snapshot.days[0]!,
            {
              date: "2026-09-11",
              dayLabel: "11 вересня (п'ятниця)",
              slots: [
                {
                  id: "c",
                  label: "12:00",
                  dateStart: "2026-09-11T12:00:00",
                  dateEnd: "2026-09-11T12:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "s1", name: "present_availability_slots", args: {} }],
          }),
          new ToolMessage({
            content: JSON.stringify({
              days: [
                snapshot.days[0],
                {
                  date: "2026-09-11",
                  dayLabel: "11 вересня (п'ятниця)",
                  slots: [
                    {
                      label: "12:00",
                      dateStart: "2026-09-11T12:00:00",
                      dateEnd: "2026-09-11T12:30:00",
                    },
                  ],
                },
              ],
              stepMinutes: 30,
              cacheHit: true,
            }),
            tool_call_id: "s1",
            name: "present_availability_slots",
          }),
          new AIMessage("invented hours 09:00"),
        ],
      }),
    );
    expect(withTool.lastHandoff?.replyButtons).toEqual([
      "10 вересня",
      "11 вересня",
      OTHER_DATE_LABEL,
    ]);

    const proseOnly = finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: {
          days: [
            snapshot.days[0]!,
            {
              date: "2026-09-11",
              dayLabel: "11 вересня (п'ятниця)",
              slots: [
                {
                  id: "c",
                  label: "12:00",
                  dateStart: "2026-09-11T12:00:00",
                  dateEnd: "2026-09-11T12:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [
          new HumanMessage("коли зручно?"),
          new AIMessage("Є вільні дні 10 і 11 вересня."),
        ],
      }),
    );
    expect(proseOnly.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("does not attach navigation when an empty-date model reply has no validated tool result", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        availabilityContext: {
          days: [
            {
              date: "2099-10-19",
              dayLabel: "19 жовтня (понеділок)",
              slots: [],
            },
          ],
          stepMinutes: 30,
          searchDirection: "later",
          searchedFrom: "2099-10-19",
        },
        agentMessages: [
          new HumanMessage("18 жовтня"),
          new AIMessage("На цю дату вільного часу немає. Пошукати іншу дату?"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("injects one compact booking draft and not full availability into booking LLM context", async () => {
    const bindTools = vi.fn(() => ({
      invoke: vi.fn(async (messages: unknown[]) => {
        const dynamic = messages[0] as HumanMessage;
        expect(String(dynamic.content)).not.toContain("<availability>");
        expect(String(dynamic.content)).toContain("<booking_draft>");
        expect(String(dynamic.content)).toContain("2026-09-10T14:00:00");
        return new AIMessage("ok");
      }),
    }));
    const model = { bindTools } as unknown as BaseChatModel;
    const llm = createAgentLlmNode({
      agent,
      model,
      tools: [],
      formatSystemMetadata: () => "DYN",
    });
    await llm(
      clinicState({
        agentMessages: [new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "note",
          serviceAcceptance: null,
          availability: null,
          selectedDate: "2026-09-10",
          selectedSlot: {
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
            label: "14:00",
          },
          note: { status: "awaiting" },
          contactId: null,
          pendingCommand: null,
        },
      }),
    );
  });

  it("prepare defers TIME clock picks to note orch; advanceBookingNoteStep still resolves the slot", async () => {
    const draft = canonicalBookingDraft({
      phase: "time",
      selectedDate: "2026-09-10",
      selectedSlot: null,
      note: { status: "unasked" },
    });
    const prepare = createAgentPrepareNode("booking");
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("14:00")],
        availabilityContext: snapshot,
        bookingDraft: draft,
      }),
    );
    expect(update.noteOrchQueued).toBe(true);
    expect(update.bookingDraft?.note.status).toBe("unasked");
    expect(update.bookingDraft?.selectedSlot).toBeNull();

    const advanced = advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage("14:00")],
      availabilityContext: snapshot,
      bookingDraft: draft,
    }));
    expect(advanced.bookingDraft?.note.status).toBe("awaiting");
    expect(advanced.bookingDraft?.selectedSlot?.label).toBe("14:00");
  });
});

describe("DDD-87: phone must appear in patient messages", () => {
  afterEach(() => {
    setTrackEventForTests(null);
  });

  const phoneTools = (onInvoke: (name: string, args: Record<string, unknown>) => void) => [
    tool(
      async (args: { phoneNumber: string }) => {
        onInvoke("find_contact_by_phone", args);
        return JSON.stringify({ success: true, total: 0, contacts: [] });
      },
      {
        name: "find_contact_by_phone",
        description: "find",
        schema: z.object({ phoneNumber: z.string() }),
      },
    ),
    tool(
      async (args: { firstName: string; phoneNumber?: string }) => {
        onInvoke("create_contact", args);
        return JSON.stringify({ success: true, id: "c-1" });
      },
      {
        name: "create_contact",
        description: "create",
        schema: z.object({
          firstName: z.string(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: { contactId: string; phoneNumber?: string }) => {
        onInvoke("update_contact", args);
        return JSON.stringify({ success: true });
      },
      {
        name: "update_contact",
        description: "update",
        schema: z.object({
          contactId: z.string(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
  ];

  it.each([
    "find_contact_by_phone",
    "create_contact",
    "update_contact",
  ] as const)("blocks invented phone on %s", async (toolName) => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    const args =
      toolName === "find_contact_by_phone"
        ? { phoneNumber: "+380689999999" }
        : toolName === "create_contact"
          ? { firstName: "Артем", lastName: "Тест", phoneNumber: "+380689999999" }
          : { contactId: "c-1", phoneNumber: "+380689999999" };
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Артем"), new HumanMessage("Тест")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{ id: "p1", name: toolName, args, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content))).toEqual({
      error: "Phone not provided",
      hint: "Ask the patient for their clinic phone, then retry with the number they typed.",
    });
    expect(seen).toContainEqual(
      expect.objectContaining({
        name: "tool_error",
        props: expect.objectContaining({
          tool: toolName,
          error_message: "Phone not provided",
        }),
      }),
    );
  });

  it("allows create_contact when human typed local UA and tool passes E.164", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada"), new HumanMessage("0501112233")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "p1",
                name: "create_contact",
                args: {
                  firstName: "Ada",
                  phoneNumber: "+380501112233",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: { firstName: "Ada", phoneNumber: "+380501112233" },
      },
    ]);
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      id: "c-1",
    });
  });

  it("allows find when human typed spaced local matching tool E.164", async () => {
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("050 111 22 33")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "p1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380501112233" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual(["find_contact_by_phone"]);
  });

  it("does not treat AI or tool text as patient-provided phone", async () => {
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    const update = await toolsNode(
      clinicState({
        messages: [
          new AIMessage("Ваш номер +380501112233?"),
          new ToolMessage({
            content: JSON.stringify({ phoneNumber: "+380501112233" }),
            tool_call_id: "x",
            name: "create_contact",
          }),
          new HumanMessage("Тест"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "p1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380501112233" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content)).error).toBe(
      "Phone not provided",
    );
  });

  it("create_contact without phoneNumber still runs", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "p1",
                name: "create_contact",
                args: { firstName: "Ada" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ name: "create_contact", args: { firstName: "Ada" } }]);
  });
});

describe("DDD-59: name must appear in patient messages", () => {
  afterEach(() => {
    setTrackEventForTests(null);
  });

  const nameTools = (onInvoke: (name: string, args: Record<string, unknown>) => void) => [
    tool(
      async (args: { firstName: string; lastName?: string; phoneNumber?: string }) => {
        onInvoke("create_contact", args);
        return JSON.stringify({ success: true, id: "c-1" });
      },
      {
        name: "create_contact",
        description: "create",
        schema: z.object({
          firstName: z.string(),
          lastName: z.string().optional(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: {
        contactId: string;
        firstName?: string;
        lastName?: string;
        phoneNumber?: string;
      }) => {
        onInvoke("update_contact", args);
        return JSON.stringify({ success: true });
      },
      {
        name: "update_contact",
        description: "update",
        schema: z.object({
          contactId: z.string(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
  ];

  it.each(["create_contact", "update_contact"] as const)(
    "blocks invented Пацієнт on %s even when phone was typed",
    async (toolName) => {
      const seen: { name: string; props: Record<string, unknown> }[] = [];
      setTrackEventForTests((name, props) => {
        seen.push({ name, props });
      });
      const invoked: string[] = [];
      const toolsNode = createAgentToolsNode(
        nameTools((name) => {
          invoked.push(name);
        }),
        "booking",
      );
      const args =
        toolName === "create_contact"
          ? {
              firstName: "Пацієнт",
              lastName: "Пацієнт",
              phoneNumber: "+380671675272",
            }
          : {
              contactId: "c-1",
              firstName: "Пацієнт",
              lastName: "Пацієнт",
              phoneNumber: "+380671675272",
            };
      const update = await toolsNode(
        clinicState({
          messages: [new HumanMessage("0671675272")],
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: "n1", name: toolName, args, type: "tool_call" }],
            }),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toEqual([]);
      const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
      expect(JSON.parse(String(toolMsg.content))).toEqual({
        error: "Name not provided",
        hint: "Ask the patient for their name, then retry with the value they typed.",
      });
      expect(seen).toContainEqual(
        expect.objectContaining({
          name: "tool_error",
          props: expect.objectContaining({
            tool: toolName,
            error_message: "Name not provided",
          }),
        }),
      );
    },
  );

  it("allows create_contact when human typed first then last name", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      nameTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [
          new HumanMessage("Марія"),
          new HumanMessage("Коваленко"),
          new HumanMessage("0501112233"),
        ],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "n1",
                name: "create_contact",
                args: {
                  firstName: "Марія",
                  lastName: "Коваленко",
                  phoneNumber: "+380501112233",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: {
          firstName: "Марія",
          lastName: "Коваленко",
          phoneNumber: "+380501112233",
        },
      },
    ]);
  });

  it("allows update_contact when human typed both names in one line", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      nameTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("Марія Коваленко")],
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "n1",
                name: "update_contact",
                args: {
                  contactId: "c-1",
                  firstName: "Марія",
                  lastName: "Коваленко",
                },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "update_contact",
        args: {
          contactId: "c-1",
          firstName: "Марія",
          lastName: "Коваленко",
        },
      },
    ]);
  });
});

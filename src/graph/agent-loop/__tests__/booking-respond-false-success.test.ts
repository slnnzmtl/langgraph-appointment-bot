import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_OFFER_MENU,
  BOOKING_REPLACE_MENU,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  LATER_DATE_LABEL,
  MAIN_MENU_GREETING_UK,
  MAIN_MENU_LABEL,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  SERVICE_CONFIRM_CONSULTATION_UK,
  defaultMenuLabels,
} from "../../../shared/clinic-constants.js";
import { setTrackEventForTests } from "../../../analytics/track.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import type { BookingDecision } from "../../booking-domain/decision.js";
import type { PendingInteraction } from "../../booking-session.js";
import type { ILLMConnector } from "../../types.js";
import { createBookingDecideNode } from "../booking-decide-nodes.js";
import { createBookingRespondNode } from "../booking-respond.js";
import { replyChoicesFromCard } from "../booking-card-choices.js";

const confirmServiceDecision = (): BookingDecision => ({
  tag: "ask",
  intent: "confirm_service",
  facts: { serviceId: CONSULTATION_SERVICE_ID },
  card: {
    kind: "service_confirm",
    serviceId: CONSULTATION_SERVICE_ID,
    choiceIds: ["offer_accept", "offer_choose_other"],
    labels: {
      offer_accept: BOOKING_OFFER_MENU[0],
      offer_choose_other: BOOKING_OFFER_MENU[1],
    },
  },
});

const llmReturning = (text: string): ILLMConnector => ({
  bindRoutingTools: () => ({
    invoke: async () => ({ text }),
  }),
} as unknown as ILLMConnector);

describe("booking__respond card copy + markup", () => {
  it("ships code-owned confirm_service copy and replyButtons only (no replyChoices)", async () => {
    const invoke = vi.fn(async () => ({
      text: "Ви обрали послугу. Будь ласка, оберіть зручну дату та час для запису.",
    }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const decision = confirmServiceDecision();
    const update = await node({
      bookingDecision: decision,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toBe(SERVICE_CONFIRM_CONSULTATION_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyChoices).toBeUndefined();
  });

  it("rejects bare intent success without terminal commit", async () => {
    const events: Array<{ name: string }> = [];
    setTrackEventForTests((name) => {
      events.push({ name });
    });
    try {
      const node = createBookingRespondNode({
        llm: llmReturning("ok"),
      });
      const update = await node({
        bookingDecision: {
          tag: "ask",
          intent: "success",
          facts: {},
          card: null,
        },
      } as never);

      expect(update.lastHandoff?.replyText).not.toMatch(/підтверджено|готово/i);
      expect(events.some((e) => e.name === "false_success_claim")).toBe(true);
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("emits code-owned success only for terminal committed mutation", async () => {
    const node = createBookingRespondNode({
      llm: llmReturning("should not be used"),
    });
    const update = await node({
      bookingDecision: {
        tag: "terminal",
        intent: "success",
        reason: "success",
        facts: {
          action: "create",
          serviceName: "Консультація",
          dateStart: "2026-10-29T12:30:00",
          date: "2026-10-29",
          time: "12:30",
        },
        card: null,
      },
    } as never);

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Готово! Запис створено.");
    expect(text).toContain("Консультація —");
    expect(text).toContain("о 12:30 ✨");
    expect(text).toContain("Адреса:");
    expect(text).toContain("Google maps");
    expect(text).not.toContain("2026-10-29");
    expect(text).not.toContain("підтверджено");
    expect(update.lastHandoff?.replyChoices).toBeUndefined();
  });

  it("ships code-owned main menu for terminal menu without calling the LLM", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const update = await node({
      bookingDecision: {
        tag: "terminal",
        intent: "menu",
        reason: "menu",
        facts: {},
        card: null,
      },
      bookingDraft: null,
      agentMessages: [],
      bookingContext: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toBe(MAIN_MENU_GREETING_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([...defaultMenuLabels(false)]);
  });

  it("ships code-owned main menu for terminal abandon without calling the LLM", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const update = await node({
      bookingDecision: {
        tag: "terminal",
        intent: "abandon",
        reason: "abandon",
        facts: {},
        card: null,
      },
      bookingDraft: null,
      agentMessages: [],
      bookingContext: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toBe(MAIN_MENU_GREETING_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([...defaultMenuLabels(false)]);
  });

  it("ships listed DATE copy from pendingInteraction (no LLM)", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "date_select" as const,
      snapshotId: "snap-1",
      choiceIds: ["2026-09-10", "2026-09-11", "other_date"],
      labels: {
        "2026-09-10": "10 вер",
        "2026-09-11": "11 вер",
        other_date: OTHER_DATE_LABEL,
      },
    };
    const pending: PendingInteraction = {
      kind: "date_select",
      snapshot: {
        snapshotId: "snap-1",
        queryKind: "nearest",
        days: [
          {
            date: "2026-09-10",
            displayLabel: "10 вер",
            slotSummaries: ["14:00", "15:00"],
            slots: [],
          },
          {
            date: "2026-09-11",
            displayLabel: "11 вер",
            slotSummaries: ["10:00"],
            slots: [],
          },
        ],
      },
      choices: [
        { id: "2026-09-10", label: "10 вер" },
        { id: "2026-09-11", label: "11 вер" },
        { id: "other_date", label: OTHER_DATE_LABEL },
      ],
    };
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "present_dates",
        facts: {},
        card,
      },
      pendingInteraction: pending,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toContain("Найближчі вільні дні");
    expect(update.lastHandoff?.replyText).toContain("10 вер: 14:00, 15:00");
    expect(update.lastHandoff?.replyText).toContain("11 вер: 10:00");
    expect(update.lastHandoff?.replyButtons).toEqual([
      "10 вер",
      "11 вер",
      OTHER_DATE_LABEL,
    ]);
  });

  it("prefixes verified price on present_dates regardless of intent and clears stash", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "date_select" as const,
      snapshotId: "snap-1",
      choiceIds: ["2026-09-10", "other_date"],
      labels: {
        "2026-09-10": "10 вер",
        other_date: OTHER_DATE_LABEL,
      },
    };
    const pending: PendingInteraction = {
      kind: "date_select",
      snapshot: {
        snapshotId: "snap-1",
        days: [
          {
            date: "2026-09-10",
            displayLabel: "10 вер",
            slotSummaries: ["14:00"],
            slots: [],
          },
        ],
      },
      choices: [
        { id: "2026-09-10", label: "10 вер" },
        { id: "other_date", label: OTHER_DATE_LABEL },
      ],
    };
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "present_dates",
        facts: {
          servicePrice: "1200",
          serviceName: "Botox",
        },
        card,
      },
      pendingInteraction: pending,
      bookingDraft: {
        pendingReplyFacts: { servicePrice: "1200", serviceName: "Botox" },
      },
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toMatch(/^Вартість Botox становить 1200 грн\./);
    expect(update.bookingDraft?.pendingReplyFacts ?? null).toBeNull();
  });

  it("prefixes price facts then listed TIME copy and keeps hour chips", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "time_select" as const,
      date: "2026-09-10",
      snapshotId: "snap-1",
      choiceIds: ["s1", "s2", "other_date"],
      labels: {
        s1: "14:00",
        s2: "14:30",
        other_date: OTHER_DATE_LABEL,
      },
    };
    const pending: PendingInteraction = {
      kind: "time_select",
      date: "2026-09-10",
      snapshot: {
        snapshotId: "snap-1",
        days: [
          {
            date: "2026-09-10",
            displayLabel: "10 вер",
            slotSummaries: ["14:00", "14:30"],
            slots: [],
          },
        ],
      },
      choices: [
        { id: "s1", label: "14:00" },
        { id: "s2", label: "14:30" },
        { id: "other_date", label: OTHER_DATE_LABEL },
      ],
    };
    const update = await node({
      bookingDecision: {
        tag: "reply",
        intent: "answer_side_question",
        facts: {
          servicePrice: "500",
          serviceName: "Консультація",
        },
        card,
      },
      pendingInteraction: pending,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toMatch(/^Вартість Консультація становить 500 грн\./);
    expect(update.lastHandoff?.replyText).toContain("Вільні години на 10 вер");
    expect(update.lastHandoff?.replyButtons).toEqual([
      "14:00",
      "14:30",
      OTHER_DATE_LABEL,
    ]);
  });

  it("ships listed TIME copy with every hour from pendingInteraction (no LLM)", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "time_select" as const,
      date: "2026-09-10",
      snapshotId: "snap-1",
      choiceIds: ["s1", "s2", "s3", "s4", "other_date"],
      labels: {
        s1: "14:00",
        s2: "14:30",
        s3: "15:00",
        s4: "15:30",
        other_date: OTHER_DATE_LABEL,
      },
    };
    const pending: PendingInteraction = {
      kind: "time_select",
      date: "2026-09-10",
      snapshot: {
        snapshotId: "snap-1",
        days: [
          {
            date: "2026-09-10",
            displayLabel: "10 вер",
            slotSummaries: ["14:00", "14:30", "15:00", "15:30"],
            slots: [],
          },
        ],
      },
      choices: [
        { id: "s1", label: "14:00" },
        { id: "s2", label: "14:30" },
        { id: "s3", label: "15:00" },
        { id: "s4", label: "15:30" },
        { id: "other_date", label: OTHER_DATE_LABEL },
      ],
    };
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "present_times",
        facts: {},
        card,
      },
      pendingInteraction: pending,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toContain("Вільні години на 10 вер");
    expect(update.lastHandoff?.replyText).toContain("14:00");
    expect(update.lastHandoff?.replyText).toContain("14:30");
    expect(update.lastHandoff?.replyText).toContain("15:00");
    expect(update.lastHandoff?.replyText).toContain("15:30");
    expect(update.lastHandoff?.replyButtons).toEqual([
      "14:00",
      "14:30",
      "15:00",
      "15:30",
      OTHER_DATE_LABEL,
    ]);
  });

  it("ships emptyMode DATE copy from pendingInteraction renderer", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "date_select" as const,
      snapshotId: "empty-earlier",
      choiceIds: ["later"],
      labels: { later: LATER_DATE_LABEL },
      emptyMode: "earlier" as const,
    };
    const pending: PendingInteraction = {
      kind: "date_select",
      snapshot: {
        snapshotId: "empty-earlier",
        days: [],
        emptyMode: "earlier",
      },
      choices: [{ id: "later", label: LATER_DATE_LABEL }],
    };
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "present_dates",
        facts: {},
        card,
      },
      pendingInteraction: pending,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toBe(
      "Раніших вільних дат не знайшли. Пошукати пізніші дати?",
    );
    expect(update.lastHandoff?.replyButtons).toEqual([LATER_DATE_LABEL]);
  });

  it("ships REPLACE copy from pendingInteraction visit_select/replacement (no LLM)", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const card = {
      kind: "visit_select" as const,
      stage: "replacement" as const,
      choiceIds: ["cancel", "decline"],
      labels: {
        cancel: BOOKING_REPLACE_MENU[0],
        decline: BOOKING_REPLACE_MENU[1],
      },
    };
    const pending: PendingInteraction = {
      kind: "visit_select",
      stage: "replacement",
      choices: [
        { id: "cancel", label: BOOKING_REPLACE_MENU[0] },
        { id: "decline", label: BOOKING_REPLACE_MENU[1] },
      ],
    };
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "clarification",
        reason: "replacement_offer",
        facts: {},
        card,
      },
      pendingInteraction: pending,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toContain(
      "У вас уже є запланований візит",
    );
    expect(update.lastHandoff?.replyText).not.toContain(
      "Оберіть, будь ласка, дію зі списку",
    );
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
  });
});

describe("replyChoicesFromCard offer labels", () => {
  it("defaults offer_accept / offer_choose_other to Так / Обрати іншу процедуру", () => {
    const choices = replyChoicesFromCard({
      kind: "service_confirm",
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
    });
    expect(choices.map((c) => c.label)).toEqual([...BOOKING_OFFER_MENU]);
  });

  it("defaults REPLACE chips on visit_select/replacement", () => {
    const choices = replyChoicesFromCard({
      kind: "visit_select",
      stage: "replacement",
    });
    expect(choices.map((c) => c.label)).toEqual([...BOOKING_REPLACE_MENU]);
  });

  it("defaults HITL confirm / decline / menu", () => {
    const choices = replyChoicesFromCard({
      kind: "mutation_confirm",
      action: "create",
    });
    expect(choices.map((c) => c.label)).toEqual([
      CONFIRM_YES_LABEL,
      CONFIRM_NO_LABEL,
      MAIN_MENU_LABEL,
    ]);
  });

  it("defaults note_skip and menu on visit_note", () => {
    const choices = replyChoicesFromCard({
      kind: "visit_note",
      skipChoiceId: "note_skip",
    });
    expect(choices.map((c) => c.label)).toEqual([
      INTENT_SKIP_LABEL,
      MAIN_MENU_LABEL,
    ]);
  });
});

describe("decide + respond deferred price on availability error", () => {
  it("merges stash then ships English price and failure copy", async () => {
    const effectId = "eff_price_avail_err";
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-botox", name: "Botox", source: "catalog" },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, {
      type: "reply_facts_set",
      facts: { servicePrice: "1200", serviceName: "Botox" },
    });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: effectId,
        expectedRevision: 2,
        effect: {
          kind: "present_availability",
          queryKind: "exact",
          date: "2026-10-24",
        },
        status: "executing",
      },
    });

    const decide = createBookingDecideNode({
      interpretTurn: async () => {
        throw new Error("must not re-interpret while effect is open");
      },
    });
    const decided = await decide({
      messages: [new HumanMessage("ok")],
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: "other",
            name: "list_services",
            args: {},
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ list: [] }),
          tool_call_id: "other",
          name: "list_services",
        }),
      ],
      bookingDraft: draft,
      pendingInteraction: null,
      availabilityContext: null,
      inboundChoiceId: null,
      patientLocale: "en",
    } as never);

    expect(decided.bookingDecision?.reason).toBe("availability_failed");
    expect(decided.bookingDecision?.facts?.clarificationReason).toBe("availability_failed");
    expect(decided.bookingDecision?.facts?.servicePrice).toBe("1200");
    expect(decided.bookingDraft?.pendingReplyFacts?.servicePrice).toBe("1200");

    const respond = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({
          invoke: async () => ({ text: "should not be used" }),
        }),
      } as unknown as ILLMConnector,
    });
    const replied = await respond({
      bookingDecision: decided.bookingDecision,
      pendingInteraction: decided.pendingInteraction,
      bookingDraft: decided.bookingDraft,
      patientLocale: "en",
      messages: [new HumanMessage("What is the price?")],
    } as never);

    const text = replied.lastHandoff?.replyText ?? "";
    expect(text).toMatch(/The price of Botox is 1200 UAH\./);
    expect(text).toMatch(/could not check available times/i);
    expect(replied.bookingDraft?.pendingReplyFacts ?? null).toBeNull();
  });
});

describe("booking__respond catalog-miss on visit_note", () => {
  it("prefixes need_service prose and keeps note chips (not PATIENT_FALLBACK)", async () => {
    const invoke = vi.fn(async () => ({ text: "should not be used" }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const update = await node({
      bookingDecision: {
        tag: "ask",
        intent: "ask_note",
        reason: "need_service",
        facts: { clarificationReason: "need_service" },
        card: { kind: "visit_note", skipChoiceId: "note_skip" },
      },
      pendingInteraction: {
        kind: "visit_note",
        choices: [
          { id: "note_skip", label: INTENT_SKIP_LABEL },
          { id: "menu", label: MAIN_MENU_LABEL },
        ],
      },
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).not.toBe(PATIENT_FALLBACK_MESSAGE);
    expect(update.lastHandoff?.replyText).toMatch(/послуг/i);
    expect(update.lastHandoff?.replyButtons).toEqual([
      INTENT_SKIP_LABEL,
      MAIN_MENU_LABEL,
    ]);
  });
});

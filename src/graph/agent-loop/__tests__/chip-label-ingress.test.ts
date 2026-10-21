import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
} from "../../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
  type BookingDraft,
} from "../../booking-draft.js";
import { CATALOG_FAMILY_SELECTOR_QUERY } from "../../catalog-match.js";
import { interpretBookingTurnDeterministic } from "../../booking-domain/interpret.js";
import type { InterpretBookingTurnInput } from "../../booking-domain/interpret.js";
import type { UnderstoodBookingTurn } from "../../booking-domain/turn.js";
import { hasPendingToolCalls } from "../../tool-routing.js";
import { createBookingDecideNode } from "../booking-decide-nodes.js";
import * as stampBookingEffectMod from "../stamp-booking-effect.js";

/** Mirror production: deterministic first, then optional LLM stub. */
const withDeterministicFirst = (
  llm?: (input: InterpretBookingTurnInput) => Promise<UnderstoodBookingTurn>,
) =>
  async (input: InterpretBookingTurnInput) => {
    const deterministic = interpretBookingTurnDeterministic(input);
    if (Object.keys(deterministic).length > 0) {
      return deterministic;
    }
    return llm != null ? llm(input) : {};
  };

const SLOT_ID = "2026-10-20T1100";
const DATE_ID = "2026-10-20";

const draftAtTimeSelect = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, { type: "date_selected", date: DATE_ID });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: {
      kind: "time_select",
      date: DATE_ID,
      snapshotId: "snap-1",
      choiceIds: [SLOT_ID, "other_date"],
      labels: {
        [SLOT_ID]: "11:00",
        other_date: OTHER_DATE_LABEL,
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: [SLOT_ID, "other_date"],
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

const draftAtDateSelect = (): BookingDraft => {
  let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
    type: "service_selected",
    service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
    accepted: true,
  });
  draft = reduceBookingDraft(draft, {
    type: "decision_set",
    decision: {
      kind: "date_select",
      snapshotId: "snap-1",
      choiceIds: [DATE_ID, "other_date"],
      labels: {
        [DATE_ID]: "20 жов",
        other_date: OTHER_DATE_LABEL,
      },
    },
  });
  draft = reduceBookingDraft(draft, {
    type: "choices_offered",
    choiceIds: [DATE_ID, "other_date"],
  });
  if (draft == null) {
    throw new Error("expected draft");
  }
  return draft;
};

const availabilityContext = {
  serviceId: CONSULTATION_SERVICE_ID,
  stepMinutes: 30,
  days: [
    {
      date: DATE_ID,
      dayLabel: "20 жов",
      slots: [
        {
          id: SLOT_ID,
          label: "11:00",
          dateStart: "2026-10-20T11:00:00+03:00",
          dateEnd: "2026-10-20T11:30:00+03:00",
        },
      ],
    },
  ],
};

describe("createBookingDecideNode chip label ingress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stamps list_services when named_procedure arrives on open time_select", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => ({
        serviceIntent: { kind: "named_procedure", query: "ботокс" },
      })),
    });
    const update = await node({
      messages: [new HumanMessage("краще запиши на ботокс")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.tag).toBe("effect");
    expect(update.bookingDecision?.pendingEffect?.effect).toEqual({
      kind: "list_services",
      query: "ботокс",
    });
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const tape = (update.agentMessages as Overwrite<unknown[]>).value as never[];
    expect(hasPendingToolCalls(tape)).toBe(true);
    const ai = tape.find(
      (message) =>
        message != null
        && typeof message === "object"
        && "tool_calls" in message
        && Array.isArray((message as { tool_calls?: unknown }).tool_calls),
    ) as { tool_calls?: Array<{ name: string; args: Record<string, unknown> }> } | undefined;
    expect(ai?.tool_calls?.[0]?.name).toBe("list_services");
    expect(ai?.tool_calls?.[0]?.args).toMatchObject({
      query: "ботокс",
      __bookingEffectStamp: "bookingEffectV1",
    });
  });

  it("unstamped present_availability fails closed without re-offering DATE/TIME", async () => {
    vi.spyOn(stampBookingEffectMod, "stampBookingEffect").mockReturnValue(null);
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => ({
        scheduleIntent: { kind: "relative", queryKind: "nearest" },
      })),
    });
    const update = await node({
      messages: [new HumanMessage("найближчий час")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.card?.kind).not.toBe("time_select");
    expect(update.bookingDecision?.card?.kind).not.toBe("date_select");
    expect(update.bookingDecision).toMatchObject({
      tag: "ask",
      reason: "availability_failed",
    });
    expect(hasPendingToolCalls(update.agentMessages ?? [])).toBe(false);
    expect(update.lastHandoff?.replyText).not.toBe(PATIENT_FALLBACK_MESSAGE);
  });

  it("maps reply-keyboard 11:00 to the slot id when inboundChoiceId is null", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for a matched chip");
      }),
    });
    const update = await node({
      messages: [new HumanMessage("11:00")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.reason).not.toBe("unknown_choice");
    expect(update.bookingDecision?.reason).not.toBe("needs_interpreter");
    expect(update.bookingDraft?.selectedSlot?.dateStart).toBe(
      "2026-10-20T11:00:00+03:00",
    );
  });

  it("does not treat bare hour prose as a reply-keyboard match", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => ({})),
    });
    const update = await node({
      messages: [new HumanMessage("11")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "2026-10-20T1130", label: "11:30" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDraft?.selectedSlot?.dateStart).toBeUndefined();
    expect(update.bookingDecision?.card?.kind).toBe("time_select");
  });

  it("maps a date label and Інша дата to their choice ids", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for a matched chip");
      }),
    });

    const dateUpdate = await node({
      messages: [new HumanMessage("20 жов")],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: DATE_ID, label: "20 жов" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(dateUpdate.bookingDraft?.selectedDate).toBe(DATE_ID);
    expect(dateUpdate.bookingDecision?.card?.kind).toBe("time_select");

    const otherUpdate = await node({
      messages: [new HumanMessage(OTHER_DATE_LABEL)],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: DATE_ID, label: "20 жов" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(otherUpdate.bookingDecision?.pendingEffect?.effect.kind).toBe(
      "present_availability",
    );
  });

  it("does not treat bare day prose as a reply-keyboard match", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => ({})),
    });
    const update = await node({
      messages: [new HumanMessage("20")],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: DATE_ID, label: "20 жов" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDraft?.selectedDate ?? null).toBeNull();
    expect(update.bookingDecision?.card?.kind).toBe("date_select");
  });

  it("does not invent a date when bare day is ambiguous across open choices", async () => {
    let sawCallback: string | undefined;
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async (input) => {
        sawCallback = input.callbackChoiceId;
        return {};
      }),
    });
    await node({
      messages: [new HumanMessage("20")],
      agentMessages: [],
      bookingDraft: draftAtDateSelect(),
      pendingInteraction: {
        kind: "date_select",
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: "2026-10-20", label: "20 жов" },
          { id: "2026-11-20", label: "20 лис" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(sawCallback).toBeUndefined();
  });

  it("does not invent callbackChoiceId for unmatched prose on an open time card", async () => {
    let sawCallback: string | undefined;
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async (input) => {
        sawCallback = input.callbackChoiceId;
        return {};
      }),
    });
    await node({
      messages: [new HumanMessage("а скільки коштує?")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: null,
    } as never);

    expect(sawCallback).toBeUndefined();
  });

  it("prefers inboundChoiceId over a conflicting label match", async () => {
    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => {
        throw new Error("LLM interpreter must not run for an inbound choice id");
      }),
    });
    const update = await node({
      // Label would match SLOT_ID; inbound must win.
      messages: [new HumanMessage("11:00")],
      agentMessages: [],
      bookingDraft: draftAtTimeSelect(),
      pendingInteraction: {
        kind: "time_select",
        date: DATE_ID,
        snapshot: { snapshotId: "snap-1", days: [] },
        choices: [
          { id: SLOT_ID, label: "11:00" },
          { id: "other_date", label: OTHER_DATE_LABEL },
        ],
      },
      availabilityContext,
      inboundChoiceId: "other_date",
    } as never);

    expect(update.bookingDraft?.selectedSlot).toBeFalsy();
    expect(update.bookingDecision?.pendingEffect?.effect.kind).toBe(
      "present_availability",
    );
  });
});

describe("createBookingDecideNode catalog family selector", () => {
  const EFFECT_ID = "eff_22_list_services";
  const FULL_CATALOG = [
    { id: "svc-consult", name: "Консультація" },
    { id: "svc-corr", name: "Корекція ботокс" },
    { id: "svc-latin", name: "Ботулінотерапія Botox, Disport 1 зона" },
    { id: "svc-filler", name: "Філер губи" },
  ];

  const draftWithCatalogEffect = (): BookingDraft => {
    let draft: BookingDraft | null = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: {
        id: CONSULTATION_SERVICE_ID,
        name: "Консультація",
        source: "catalog",
      },
      accepted: true,
    });
    draft = reduceBookingDraft(draft, { type: "date_selected", date: DATE_ID });
    draft = reduceBookingDraft(draft, {
      type: "slot_selected",
      slot: {
        dateStart: "2026-10-20T11:00:00+03:00",
        dateEnd: "2026-10-20T11:30:00+03:00",
        label: "11:00",
      },
      snapshotId: "snap-1",
    });
    draft = reduceBookingDraft(draft, { type: "note_status", status: "awaiting" });
    draft = reduceBookingDraft(draft, {
      type: "effect_prepared",
      effect: {
        id: EFFECT_ID,
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    });
    if (draft == null) {
      throw new Error("expected draft");
    }
    return draft;
  };

  const catalogToolTape = () => [
    new AIMessage({
      content: "",
      tool_calls: [{
        id: EFFECT_ID,
        name: "list_services",
        args: { query: "ботокс" },
        type: "tool_call",
      }],
    }),
    new ToolMessage({
      content: JSON.stringify({ list: FULL_CATALOG, total: FULL_CATALOG.length }),
      tool_call_id: EFFECT_ID,
      name: "list_services",
    }),
  ];

  it("uses family selector ids (not stems) for service_candidate chips", async () => {
    const selectCandidates = vi.fn(async (input: {
      utterance: string;
      query?: string;
      candidates: Array<{ id: string; name: string }>;
    }) => {
      expect(input.utterance).toBe("ботокс");
      expect(input.query).toBe(CATALOG_FAMILY_SELECTOR_QUERY);
      expect(input.candidates.map((c) => c.id)).toEqual(
        FULL_CATALOG.map((r) => r.id),
      );
      return {
        serviceIds: ["svc-latin", "svc-corr"],
      };
    });
    const node = createBookingDecideNode({ selectCandidates });
    const update = await node({
      messages: [new HumanMessage("запиши на ботокс краще")],
      agentMessages: catalogToolTape(),
      bookingDraft: draftWithCatalogEffect(),
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "note_skip", label: INTENT_SKIP_LABEL }],
      },
      inboundChoiceId: null,
    } as never);

    expect(selectCandidates).toHaveBeenCalledTimes(1);
    expect(update.bookingDecision).toMatchObject({
      tag: "ask",
      intent: "ask_service",
      card: {
        kind: "service_candidate",
        choices: [
          { id: "svc-latin", serviceIds: ["svc-latin"] },
          { id: "svc-corr", serviceIds: ["svc-corr"] },
        ],
      },
    });
    const choices = update.bookingDecision?.card?.kind === "service_candidate"
      ? update.bookingDecision.card.choices
      : [];
    expect(choices.find((chip) => chip.id === "svc-corr")?.label).toBe("Корекція ботокс");
    expect(choices.find((chip) => chip.id === "svc-latin")?.label).toMatch(
      /^Ботулінотерапія Botox/,
    );
  });

  it("selector empty at visit_note resumes note with need_service (not PATIENT_FALLBACK)", async () => {
    const selectCandidates = vi.fn(async () => ({ serviceIds: [] as string[] }));
    const node = createBookingDecideNode({ selectCandidates });
    const update = await node({
      messages: [new HumanMessage("запиши на ботокс краще")],
      agentMessages: catalogToolTape(),
      bookingDraft: draftWithCatalogEffect(),
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "note_skip", label: INTENT_SKIP_LABEL }],
      },
      inboundChoiceId: null,
    } as never);

    expect(selectCandidates).toHaveBeenCalledTimes(1);
    expect(update.bookingDecision).toMatchObject({
      tag: "ask",
      intent: "ask_note",
      reason: "need_service",
      facts: { clarificationReason: "need_service" },
      card: { kind: "visit_note", skipChoiceId: "note_skip" },
    });
    expect(update.pendingInteraction?.kind).toBe("visit_note");
    expect(update.lastHandoff?.replyText).not.toBe(PATIENT_FALLBACK_MESSAGE);
  });

  it("opens selector groups instead of the first five CRM titles", async () => {
    const family = [
      { id: "svc-0", name: "Ботулінотерапія Botox 1 зона" },
      { id: "svc-1", name: "Ботулінотерапія Botox 2 зони" },
      { id: "svc-2", name: "Ботулінотерапія Botox 3 зони" },
      { id: "svc-3", name: "Ботулінотерапія Disport 1 зона" },
      { id: "svc-4", name: "Ботулінотерапія Disport 2 зони" },
      { id: "svc-5", name: "Ботулінотерапія Disport 3 зони" },
    ];
    const selectCandidates = vi.fn(async () => ({
      serviceIds: family.map((row) => row.id),
      groups: [
        { label: "Botox", serviceIds: ["svc-0", "svc-1", "svc-2"] },
        { label: "Disport", serviceIds: ["svc-3", "svc-4", "svc-5"] },
      ],
    }));
    const node = createBookingDecideNode({ selectCandidates });
    const update = await node({
      messages: [new HumanMessage("запиши на ботокс краще")],
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: EFFECT_ID,
            name: "list_services",
            args: { query: "ботокс" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ list: family, total: family.length }),
          tool_call_id: EFFECT_ID,
          name: "list_services",
        }),
      ],
      bookingDraft: draftWithCatalogEffect(),
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "note_skip", label: INTENT_SKIP_LABEL }],
      },
      inboundChoiceId: null,
    } as never);

    expect(update.bookingDecision?.card).toMatchObject({
      kind: "service_candidate",
      choices: [
        { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1", "svc-2"] },
        { id: "g1", label: "Disport", serviceIds: ["svc-3", "svc-4", "svc-5"] },
      ],
    });
    expect(update.pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "booking",
      choices: [
        { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1", "svc-2"] },
        { id: "g1", label: "Disport", serviceIds: ["svc-3", "svc-4", "svc-5"] },
      ],
    });
    expect(update.bookingDraft?.pendingDecision).toMatchObject({
      kind: "service_candidate",
      query: "ботокс",
      catalogRows: family,
      choices: [
        { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1", "svc-2"] },
        { id: "g1", label: "Disport", serviceIds: ["svc-3", "svc-4", "svc-5"] },
      ],
    });
  });

  it("singleton group tap uses the CRM row name, not the group label", async () => {
    let draft = draftWithCatalogEffect();
    draft = reduceBookingDraft(draft, { type: "effect_cleared" });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-deep", name: "Ботулінотерапія Botox 3 зони" },
        ],
        choices: [{ id: "g0", label: "Botox", serviceIds: ["svc-deep"] }],
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "choices_offered",
      choiceIds: ["g0"],
    });
    const node = createBookingDecideNode();
    const update = await node({
      messages: [new HumanMessage("Botox")],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction: {
        kind: "service_candidate",
        utterance: "ботокс",
        query: "ботокс",
        owner: "booking",
        choices: [{ id: "g0", label: "Botox", serviceIds: ["svc-deep"] }],
      },
      inboundChoiceId: "g0",
      servicesContext: { list: [], truncated: true },
    } as never);

    expect(update.bookingDraft?.serviceAcceptance?.service).toMatchObject({
      id: "svc-deep",
      name: "Ботулінотерапія Botox 3 зони",
    });
  });

  it("reaches a family row beyond the first 60 catalog entries via a group tap", async () => {
    const pads = Array.from({ length: 61 }, (_, index) => ({
      id: `pad-${index}`,
      name: `Pad ${index}`,
    }));
    const familyHead = Array.from({ length: 8 }, (_, index) => ({
      id: `fam-${index}`,
      name: `Family ${index}`,
    }));
    const deep = { id: "svc-deep", name: "Ботулінотерапія глибока зона" };
    const fullCatalog = [...pads, ...familyHead, deep];
    expect(fullCatalog.findIndex((row) => row.id === "svc-deep")).toBeGreaterThanOrEqual(60);

    const familyIds = [...familyHead.map((row) => row.id), deep.id];
    const selectCandidates = vi.fn(async () => ({
      serviceIds: familyIds,
      groups: [
        { label: "Botox", serviceIds: familyHead.slice(0, 4).map((row) => row.id) },
        {
          label: "Інші варіанти",
          serviceIds: [...familyHead.slice(4).map((row) => row.id), deep.id],
        },
      ],
    }));
    const node = createBookingDecideNode({ selectCandidates });
    const opened = await node({
      messages: [new HumanMessage("запиши на ботокс краще")],
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: EFFECT_ID,
            name: "list_services",
            args: { query: "ботокс" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ list: fullCatalog, total: fullCatalog.length }),
          tool_call_id: EFFECT_ID,
          name: "list_services",
        }),
      ],
      bookingDraft: draftWithCatalogEffect(),
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "note_skip", label: INTENT_SKIP_LABEL }],
      },
      inboundChoiceId: null,
      servicesContext: { list: pads.slice(0, 60), truncated: true, total: fullCatalog.length },
    } as never);

    const openedIds = opened.bookingDecision?.card?.kind === "service_candidate"
      ? opened.bookingDecision.card.choices.map((chip) => chip.id)
      : [];
    expect(openedIds).toEqual(["g0", "g1"]);
    expect(
      opened.bookingDraft?.pendingDecision?.kind === "service_candidate"
        ? opened.bookingDraft.pendingDecision.catalogRows?.some((row) => row.id === "svc-deep")
        : false,
    ).toBe(true);

    const paged = await node({
      messages: [new HumanMessage("Інші варіанти")],
      agentMessages: [],
      bookingDraft: opened.bookingDraft,
      pendingInteraction: opened.pendingInteraction,
      inboundChoiceId: "g1",
      servicesContext: { list: pads.slice(0, 60), truncated: true, total: fullCatalog.length },
    } as never);

    expect(paged.bookingDecision?.card).toMatchObject({
      kind: "service_candidate",
    });
    // Drill-down keeps the family probe — never the chip label («Інші варіанти»).
    expect(paged.bookingDraft?.pendingDecision).toMatchObject({
      kind: "service_candidate",
      query: "ботокс",
    });
    const pageIds = paged.bookingDecision?.card?.kind === "service_candidate"
      ? paged.bookingDecision.card.choices.map((chip) => chip.id)
      : [];
    expect(pageIds).toContain("svc-deep");

    const selected = await node({
      messages: [new HumanMessage("Ботулінотерапія глибока зона")],
      agentMessages: [],
      bookingDraft: paged.bookingDraft,
      pendingInteraction: paged.pendingInteraction,
      inboundChoiceId: "svc-deep",
      servicesContext: { list: pads.slice(0, 60), truncated: true, total: fullCatalog.length },
    } as never);

    expect(selected.bookingDraft?.serviceAcceptance?.service).toMatchObject({
      id: "svc-deep",
      name: "Ботулінотерапія глибока зона",
    });
  });

  it("rejects a stale unoffered group id without selecting a CRM service", async () => {
    let draft = draftWithCatalogEffect();
    draft = reduceBookingDraft(draft, { type: "effect_cleared" });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-0", name: "A" },
          { id: "svc-1", name: "B" },
        ],
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
        ],
      },
    });
    const node = createBookingDecideNode();
    const update = await node({
      messages: [new HumanMessage("stale")],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction: {
        kind: "service_candidate",
        utterance: "ботокс",
        query: "ботокс",
        owner: "booking",
        choices: [{ id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] }],
      },
      inboundChoiceId: "g99",
    } as never);

    expect(update.bookingDraft?.serviceAcceptance?.service?.id).not.toBe("svc-0");
    expect(update.bookingDraft?.serviceAcceptance?.service?.id).not.toBe("svc-1");
    expect(update.bookingDecision?.card?.kind).toBe("service_candidate");
  });

  it("ignores a buried catalogRows CRM id that is not on the current chip page", async () => {
    let draft = draftWithCatalogEffect();
    draft = reduceBookingDraft(draft, { type: "effect_cleared" });
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "ботокс",
        catalogRows: [
          { id: "svc-0", name: "A" },
          { id: "svc-1", name: "B" },
          { id: "svc-2", name: "C" },
        ],
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
          { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
        ],
      },
    });
    const node = createBookingDecideNode();
    const buried = await node({
      messages: [new HumanMessage("svc-0")],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction: {
        kind: "service_candidate",
        utterance: "ботокс",
        query: "ботокс",
        owner: "booking",
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
          { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
        ],
      },
      inboundChoiceId: "svc-0",
    } as never);
    expect(buried.bookingDraft?.serviceAcceptance?.service?.id).not.toBe("svc-0");
    expect(buried.bookingDecision?.card?.kind).toBe("service_candidate");

    const groupTap = await node({
      messages: [new HumanMessage("Botox")],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction: buried.pendingInteraction ?? {
        kind: "service_candidate",
        utterance: "ботокс",
        query: "ботокс",
        owner: "booking",
        choices: [
          { id: "g0", label: "Botox", serviceIds: ["svc-0", "svc-1"] },
          { id: "g1", label: "Disport", serviceIds: ["svc-2"] },
        ],
      },
      inboundChoiceId: "g0",
    } as never);
    expect(groupTap.bookingDecision?.card?.kind).toBe("service_candidate");
    const pageIds = groupTap.bookingDecision?.card?.kind === "service_candidate"
      ? groupTap.bookingDecision.card.choices.map((chip) => chip.id)
      : [];
    expect(pageIds).toEqual(expect.arrayContaining(["svc-0", "svc-1"]));
  });

  it("group tap after CRM id g1 collision pages the group, not the CRM singleton", async () => {
    const catalog = [
      { id: "g1", name: "CRM Service G1" },
      { id: "svc-a", name: "Alpha" },
      { id: "svc-b", name: "Beta" },
    ];
    const selectCandidates = vi.fn(async () => ({
      serviceIds: catalog.map((row) => row.id),
      groups: [
        { label: "CRM Service G1", serviceIds: ["g1"] },
        { label: "Family", serviceIds: ["svc-a", "svc-b"] },
      ],
    }));
    const node = createBookingDecideNode({ selectCandidates });
    const opened = await node({
      messages: [new HumanMessage("запиши на ботокс краще")],
      agentMessages: [
        new AIMessage({
          content: "",
          tool_calls: [{
            id: EFFECT_ID,
            name: "list_services",
            args: { query: "ботокс" },
            type: "tool_call",
          }],
        }),
        new ToolMessage({
          content: JSON.stringify({ list: catalog, total: catalog.length }),
          tool_call_id: EFFECT_ID,
          name: "list_services",
        }),
      ],
      bookingDraft: draftWithCatalogEffect(),
      pendingInteraction: {
        kind: "visit_note",
        choices: [{ id: "note_skip", label: INTENT_SKIP_LABEL }],
      },
      inboundChoiceId: null,
    } as never);

    const choices = opened.bookingDecision?.card?.kind === "service_candidate"
      ? opened.bookingDecision.card.choices
      : [];
    expect(new Set(choices.map((chip) => chip.id)).size).toBe(choices.length);
    const crm = choices.find((chip) => chip.serviceIds?.length === 1 && chip.serviceIds[0] === "g1");
    const group = choices.find(
      (chip) => chip.serviceIds?.includes("svc-a") === true
        && chip.serviceIds?.includes("svc-b") === true,
    );
    expect(crm?.id).toBe("g1");
    expect(group).toBeDefined();
    expect(group!.id).not.toBe("g1");

    const paged = await node({
      messages: [new HumanMessage(group!.label)],
      agentMessages: [],
      bookingDraft: opened.bookingDraft,
      pendingInteraction: opened.pendingInteraction,
      inboundChoiceId: group!.id,
    } as never);
    expect(paged.bookingDraft?.serviceAcceptance?.service?.id).not.toBe("g1");
    expect(paged.bookingDecision?.card?.kind).toBe("service_candidate");
    const pageIds = paged.bookingDecision?.card?.kind === "service_candidate"
      ? paged.bookingDecision.card.choices.map((chip) => chip.id)
      : [];
    expect(pageIds).toEqual(expect.arrayContaining(["svc-a", "svc-b"]));
    expect(pageIds).not.toContain("g1");
  });
});

describe("createBookingDecideNode unstamped effect next-turn tap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps service_candidate after unstamped availability and selects on the next tap", async () => {
    vi.spyOn(stampBookingEffectMod, "stampBookingEffect").mockReturnValue(null);

    let draft: BookingDraft | null = createEmptyBookingDraft();
    draft = reduceBookingDraft(draft, {
      type: "decision_set",
      decision: {
        kind: "service_candidate",
        query: "послуги",
        catalogRows: [
          { id: "svc-a", name: "Alpha" },
          { id: "svc-b", name: "Beta" },
        ],
        choices: [
          { id: "svc-a", label: "Alpha", serviceIds: ["svc-a"] },
          { id: "svc-b", label: "Beta", serviceIds: ["svc-b"] },
        ],
      },
    });
    draft = reduceBookingDraft(draft, {
      type: "choices_offered",
      choiceIds: ["svc-a", "svc-b"],
    });
    if (draft == null) {
      throw new Error("expected draft");
    }

    const pendingInteraction = {
      kind: "service_candidate" as const,
      utterance: "послуги",
      query: "послуги",
      owner: "booking" as const,
      choices: [
        { id: "svc-a", label: "Alpha", serviceIds: ["svc-a"] },
        { id: "svc-b", label: "Beta", serviceIds: ["svc-b"] },
      ],
    };

    const node = createBookingDecideNode({
      interpretTurn: withDeterministicFirst(async () => ({
        scheduleIntent: { kind: "relative", queryKind: "nearest" },
      })),
    });
    const failed = await node({
      messages: [new HumanMessage("найближчий час")],
      agentMessages: [],
      bookingDraft: draft,
      pendingInteraction,
      inboundChoiceId: null,
    } as never);

    expect(failed.bookingDecision?.reason).toBe("availability_failed");
    expect(failed.bookingDecision?.card?.kind).toBe("service_candidate");
    expect(hasPendingToolCalls(failed.agentMessages ?? [])).toBe(false);

    const selected = await node({
      messages: [new HumanMessage("Alpha")],
      agentMessages: [],
      bookingDraft: failed.bookingDraft,
      pendingInteraction: failed.pendingInteraction ?? pendingInteraction,
      inboundChoiceId: "svc-a",
    } as never);

    expect(selected.bookingDraft?.serviceAcceptance?.service).toMatchObject({
      id: "svc-a",
      name: "Alpha",
    });
  });
});



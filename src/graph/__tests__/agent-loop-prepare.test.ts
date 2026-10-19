import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createAgentCommandPrepareNode,
  createBookingFinalizeNode,
  createBookingPrepareNode,
  createFaqPrepareNode,
  createAgentToolsNode,
  offeredServiceForTurn,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import {
  BOOKING_REPLACE_MENU,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  DEFAULT_MENU_NO_VISITS,
} from "../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import { reduceBookingSession } from "../booking-session.js";
import { type ClinicAgentDefinition } from "../types.js";

import {
  canonicalBookingDraft,
  clinicState,
  makeListedContact,
  makeListedMeetings,
  ownedContactContext,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";


describe("createBookingPrepareNode / createFaqPrepareNode", () => {
  it("keeps original human message without synthetic ToolMessages or CRM writes", async () => {
    const prepare = createBookingPrepareNode();

    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Book tomorrow")],
        stepCount: 5,
        next: "booking",
        contactContext: makeListedContact(),
        bookingContext: { meetings: [], dateFrom: "2026-08-11" },
      }),
    );

    expect(update.stepCount).toBe(0);
    expect(update.agentMessages).toBeInstanceOf(Overwrite);
    const agentMessages = (unwrapCommandUpdate(update).agentMessages as Overwrite<unknown[]>).value;
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toBeInstanceOf(HumanMessage);
    expect((agentMessages[0] as HumanMessage).content).toBe("Book tomorrow");
    expect(agentMessages.some((m) => m instanceof ToolMessage)).toBe(false);
    expect(update.contactContext).toBeUndefined();
    expect(update.bookingContext).toBeUndefined();
    expect(update.servicesContext).toBeUndefined();
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement ?? null).toBeNull();
  });

  it("offers REPLACE when bookingContext already has a Planned visit", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: makeListedMeetings(),
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.mode).toBe("replace");
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement).toMatchObject({
      status: "offered",
      meeting: { id: "m-1", name: "Консультація - Daniel" },
    });
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement?.originalCommand).toBeUndefined();
    expect(
      routeAfterAgentPrepare(
        clinicState({
          bookingDraft: unwrapCommandUpdate(update).bookingDraft,
          pendingInteraction: null,
        }),
        "booking__llm",
        "booking__command_prepare",
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
  });

  it("supersedes an action-stage visit menu with REPLACE on explicit Записатись", async () => {
    const prepare = createBookingPrepareNode();
    const actionInteraction = {
      kind: "visit_select" as const,
      stage: "action" as const,
      meetingId: "m-1",
      meetings: makeListedMeetings().meetings,
      choices: [
        { id: "reschedule", label: "Перенести" },
        { id: "cancel", label: "Скасувати" },
        { id: "decline", label: "Ні, дякую" },
      ],
    };
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: makeListedMeetings(),
        pendingInteraction: actionInteraction,
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.replacement).toMatchObject({
      status: "offered",
      meeting: { id: "m-1" },
    });
    const effectiveState = clinicState({
      messages: [new HumanMessage("Записатись")],
      bookingContext: makeListedMeetings(),
      bookingDraft: unwrapCommandUpdate(update).bookingDraft,
      pendingInteraction: actionInteraction,
    });
    expect(
      routeAfterAgentPrepare(
        effectiveState,
        "booking__llm",
        "booking__command_prepare",
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");

    const finalized = await createBookingFinalizeNode(bookingAgent)(effectiveState);
    expect(finalized.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "replacement",
      meetingId: "m-1",
    });
    expect(finalized.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
  });

  it("supersedes a stale action-stage menu with consultation when no visit exists", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: { meetings: [], dateFrom: "2026-08-11" },
        pendingInteraction: {
          kind: "visit_select",
          stage: "action",
          meetingId: "m-stale",
          meetings: [{ id: "m-stale" }],
          choices: [
            { id: "reschedule", label: "Перенести" },
            { id: "cancel", label: "Скасувати" },
            { id: "decline", label: "Ні, дякую" },
          ],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.replacement ?? null).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
  });

  it("opens consultation offer on Записатись when bookingContext has no visits", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: { meetings: [], dateFrom: "2026-08-11" },
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID },
    });
    const prepared = unwrapCommandUpdate(update);
    expect(false).toBe(true);
    expect(
      routeAfterAgentPrepare(
        clinicState({
          messages: [new HumanMessage("Записатись")],
          bookingDraft: prepared.bookingDraft,
          pendingInteraction: prepared.pendingInteraction,
        }),
        "booking__llm",
        "booking__command_prepare",
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
  });

  it("honors null bookingDraft from invalid reschedule schedule repair", async () => {
    const prepare = createBookingPrepareNode();
    const dateSelect = {
      kind: "date_select" as const,
      snapshot: {
        snapshotId: "snap-1",
        days: [{
          date: "2026-10-13",
          displayLabel: "13 жовтня",
          slotSummaries: ["11:00"],
          slots: [],
        }],
      },
      choices: [{ id: "2026-10-13", label: "13 жовтня" }],
    };
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("hello")],
        bookingDraft: {
          ...createEmptyBookingDraft(),
          mode: "reschedule",
          rescheduleTarget: null,
        },
        pendingInteraction: dateSelect,
        availabilityContext: {
          days: [{
            date: "2026-10-13",
            dayLabel: "13 жовтня",
            slots: [{
              id: "slot-11",
              label: "11:00",
              dateStart: "2026-10-13T11:00:00",
              dateEnd: "2026-10-13T11:30:00",
            }],
          }],
          stepMinutes: 30,
        },
        availabilityCursor: { from: "2026-10-13", through: "2026-10-20" },
        bookingContext: {
          meetings: [{
            id: "m-1",
            name: "Visit",
            dateStart: "2026-10-20 11:00:00",
          }],
          dateFrom: "2026-10-11",
        },
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("visit_select");
    expect(update.availabilityContext).toBeNull();
    expect(update.availabilityCursor).toBeNull();
    expect(false).toBe(false);
  });

  it("honors null pendingInteraction from mismatched TIME schedule repair", async () => {
    const prepare = createBookingPrepareNode();
    const accepted = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: "svc-botox", name: "Botox", source: "catalog" },
      accepted: true,
    });
    const dated = reduceBookingDraft(accepted, {
      type: "date_selected",
      date: "2026-10-17",
    })!;
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("hello")],
        bookingDraft: dated,
        pendingInteraction: {
          kind: "time_select",
          date: "2026-10-99",
          snapshot: {
            snapshotId: "snap-1",
            days: [{
              date: "2026-10-13",
              displayLabel: "13 жовтня",
              slotSummaries: ["11:00"],
              slots: [],
            }],
          },
          choices: [{ id: "slot-11", label: "11:00" }],
        },
        availabilityContext: {
          days: [{
            date: "2026-10-13",
            dayLabel: "13 жовтня",
            slots: [{
              id: "slot-11",
              label: "11:00",
              dateStart: "2026-10-13T11:00:00",
              dateEnd: "2026-10-13T11:30:00",
            }],
          }],
          stepMinutes: 30,
        },
        availabilityCursor: { from: "2026-10-13", through: "2026-10-20" },
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate).toBeNull();
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(update.availabilityContext).toBeNull();
    expect(update.availabilityCursor).toBeNull();
    expect(false).toBe(false);
  });

  it("keeps accepted service when REPLACE is offered before a slot", async () => {
    const prepare = createBookingPrepareNode();
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
      accepted: true,
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: makeListedMeetings(),
        bookingDraft: draft,
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement?.status).toBe("offered");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: CONSULTATION_SERVICE_ID },
    });
  });

  const bookingAgent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("does not guess a named procedure into the draft when REPLACE opens", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("запиши на колаген")],
        bookingContext: makeListedMeetings(),
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
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.replacement?.status).toBe("offered");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance ?? null).toBeNull();

    const finalize = createBookingFinalizeNode(bookingAgent);
    const rendered = await finalize(
      clinicState({
        messages: [new HumanMessage("запиши на колаген")],
        bookingContext: makeListedMeetings(),
        bookingDraft: unwrapCommandUpdate(update).bookingDraft,
        agentMessages: [new HumanMessage("запиши на колаген")],
      }),
    );
    expect(rendered.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "replacement",
    });
    expect(rendered.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
  });

  it("does not open consultation after REPLACE cancel when a named service was accepted", async () => {
    const cancelTool = tool(
      async () => JSON.stringify({
        success: true,
        id: "m-1",
        status: "Not Held",
      }),
      {
        name: "cancel_meeting",
        description: "cancel",
        schema: z.object({ meetingId: z.string() }),
      },
    );
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "service_selected",
        service: {
          id: "svc-collagen",
          name: "Колагеностимуляція Полімолочна кислота",
          source: "catalog",
          durationMinutes: 60,
        },
        accepted: true,
      }),
      {
        type: "existing_booking_detected",
        meeting: makeListedMeetings().meetings[0]!,
      },
    );
    const cancelling = reduceBookingDraft(draft, {
      type: "cancel_existing_requested",
      command: {
        action: "cancel",
        payload: { meetingId: "m-1" },
      },
    });
    const update = await createAgentToolsNode([cancelTool], "booking")(
      clinicState({
        bookingContext: makeListedMeetings(),
        bookingDraft: cancelling,
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "cancel",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          runtimeToolAi([{
              id: "cancel-1",
              name: "cancel_meeting",
              args: { meetingId: "m-1" },
              type: "tool_call",
            }]),
        ],
      }),
      { configurable: {} },
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.replacement).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.mode).toBe("create");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "accepted",
      service: { id: "svc-collagen" },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
  });

  it("leaves unmatched free text on an open booking offer for the booking LLM", async () => {
    const prepare = createBookingPrepareNode();
    const offered = reduceBookingSession(
      { bookingDraft: null, pendingInteraction: null },
      {
        type: "service_offered",
        service: {
          id: CONSULTATION_SERVICE_ID,
          name: "Консультація",
          source: "catalog",
        },
      },
    );

    for (const utterance of ["запиши на колаген", "ні, на колаген"] as const) {
      const update = await prepare(
        clinicState({
          messages: [new HumanMessage(utterance)],
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
          bookingDraft: offered.bookingDraft,
          pendingInteraction: offered.pendingInteraction,
        }),
      );

      // No stem routing — offer stays pending for the booking LLM.
      expect(unwrapCommandUpdate(update).pendingInteraction ?? offered.pendingInteraction).toMatchObject({
        kind: "service_confirm",
        service: { id: CONSULTATION_SERVICE_ID },
      });
      expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.service.id ?? offered.bookingDraft?.serviceAcceptance?.service.id)
        .toBe(CONSULTATION_SERVICE_ID);
    }
  });

  it("finalize renders REPLACE after prepare offers an existing visit", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: makeListedMeetings().meetings[0]!,
    });
    const finalize = createBookingFinalizeNode(bookingAgent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        bookingContext: makeListedMeetings(),
        bookingDraft: draft,
        agentMessages: [new HumanMessage("Записатись")],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "replacement",
    });
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
    expect(update.lastHandoff?.replyButtons).not.toContain("Перенести");
  });

  it("Скасувати on REPLACE opens cancel HITL for the blocking meeting", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: makeListedMeetings().meetings[0]!,
    });
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Скасувати")],
        bookingContext: makeListedMeetings(),
        bookingDraft: draft,
        pendingInteraction: {
          kind: "visit_select",
          stage: "replacement",
          meetingId: "m-1",
          meetings: [makeListedMeetings().meetings[0]!],
          choices: [
            { id: "cancel_existing", label: BOOKING_REPLACE_MENU[0] },
            { id: "decline", label: BOOKING_REPLACE_MENU[1] },
          ],
        },
        agentMessages: [new HumanMessage("Скасувати")],
      }),
    );
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    expect(messages.at(-1)?.tool_calls?.[0]).toMatchObject({
      name: "cancel_meeting",
      args: { meetingId: "m-1" },
    });
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBe("replacement");
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement?.status).toBe("cancelling");
  });

  it("Ні, дякую on REPLACE clears the draft", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: makeListedMeetings().meetings[0]!,
    });
    const commandPrepare = createAgentCommandPrepareNode();
    const update = await commandPrepare(
      clinicState({
        messages: [new HumanMessage("Ні, дякую")],
        bookingContext: makeListedMeetings(),
        bookingDraft: draft,
        pendingInteraction: {
          kind: "visit_select",
          stage: "replacement",
          meetingId: "m-1",
          meetings: [makeListedMeetings().meetings[0]!],
          choices: [
            { id: "cancel_existing", label: BOOKING_REPLACE_MENU[0] },
            { id: "decline", label: BOOKING_REPLACE_MENU[1] },
          ],
        },
        agentMessages: [new HumanMessage("Ні, дякую")],
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
  });

  it("committed replacement cancel without originalCommand opens FAQ catalog", async () => {
    const cancelTool = tool(
      async () => JSON.stringify({
        success: true,
        id: "m-1",
        status: "Not Held",
      }),
      {
        name: "cancel_meeting",
        description: "cancel",
        schema: z.object({ meetingId: z.string() }),
      },
    );
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "existing_booking_detected",
      meeting: makeListedMeetings().meetings[0]!,
    });
    const cancelling = reduceBookingDraft(draft, {
      type: "cancel_existing_requested",
      command: {
        action: "cancel",
        payload: { meetingId: "m-1" },
      },
    });
    const servicesContext = {
      list: [
        { id: "svc-botox", name: "Ботулінотерапія Botox 1 зона" },
        { id: "svc-peel", name: "Пілінг поверхневий" },
        { id: "svc-lip", name: "збільшення губ" },
      ],
    };
    const update = await createAgentToolsNode([cancelTool], "booking")(
      clinicState({
        bookingContext: makeListedMeetings(),
        bookingDraft: cancelling,
        servicesContext,
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "cancel",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          runtimeToolAi([{
              id: "cancel-1",
              name: "cancel_meeting",
              args: { meetingId: "m-1" },
              type: "tool_call",
            }]),
        ],
      }),
      { configurable: {} },
    );
    expect(unwrapCommandUpdate(update).bookingDraft?.replacement).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.mode).toBe("create");
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand).toBeNull();
    // Tools only complete cancel — FAQ prepare owns the catalog open.
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(update.bookingContext?.meetings).toEqual([]);
    expect(
      routeAfterAgentTools(
        clinicState({
          bookingDraft: unwrapCommandUpdate(update).bookingDraft,
          pendingInteraction: unwrapCommandUpdate(update).pendingInteraction,
          agentMessages: update.agentMessages as never,
        }),
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          finalizeName: "booking__finalize",
          faqPrepareName: "faq__prepare",
        }),
    ).toBe("faq__prepare");
    // Without FAQ compiled, fall back to booking finalize.
    expect(
      routeAfterAgentTools(
        clinicState({
          bookingDraft: unwrapCommandUpdate(update).bookingDraft,
          pendingInteraction: null,
          agentMessages: update.agentMessages as never,
        }),
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          finalizeName: "booking__finalize",
        }),
    ).toBe("booking__finalize");

    const faqPrepare = createFaqPrepareNode();
    const prepared = await faqPrepare(
      clinicState({
        bookingDraft: unwrapCommandUpdate(update).bookingDraft,
        servicesContext,
        pendingInteraction: null,
        agentMessages: update.agentMessages as never,
      }),
    );
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toMatchObject({
      kind: "service_candidate",
      owner: "faq",
      consultationDeclined: true,
    });
    expect(
      unwrapCommandUpdate(prepared).pendingInteraction?.kind === "service_candidate"
        ? unwrapCommandUpdate(prepared).pendingInteraction.choices.length
        : 0,
    ).toBeGreaterThan(0);

    const finalize = createBookingFinalizeNode(bookingAgent);
    const rendered = await finalize(
      clinicState({
        bookingDraft: unwrapCommandUpdate(prepared).bookingDraft
          ?? unwrapCommandUpdate(update).bookingDraft,
        pendingInteraction: unwrapCommandUpdate(prepared).pendingInteraction,
        servicesContext,
        agentMessages: update.agentMessages as never,
      }),
    );
    expect(rendered.lastHandoff?.replyText).toMatch(/^Запис скасовано\./);
    expect(rendered.lastHandoff?.replyText).toContain("•");
    expect(rendered.lastHandoff?.replyButtons?.length).toBeGreaterThan(0);
    expect(rendered.lastHandoff?.replyButtons).not.toContain("Так");
  });

  it("requests nearest slots after replacement cancel with accepted service and keeps purpose", async () => {
    const draft = reduceBookingDraft(
      reduceBookingDraft(createEmptyBookingDraft(), {
        type: "service_selected",
        service: {
          id: "svc-botox",
          name: "Ботулінотерапія Botox 1 зона",
          source: "catalog",
          durationMinutes: 30,
        },
        accepted: true,
      }),
      { type: "contact_resolved", contactId: "contact-1" },
    );
    const cancelMessages = [
      runtimeToolAi([{
          id: "booking_replace_cancel_1",
          name: "cancel_meeting",
          args: { meetingId: "m-1" },
          type: "tool_call" as const,
        }]),
      new ToolMessage({
        content: JSON.stringify({ success: true, id: "m-1", meetingId: "m-1" }),
        tool_call_id: "booking_replace_cancel_1",
        name: "cancel_meeting",
      }),
    ];
    const update = await createAgentCommandPrepareNode()(
      clinicState({
        messages: [new HumanMessage("✅")],
        bookingDraft: draft,
        pendingInteraction: null,
        contactContext: ownedContactContext(),
        agentMessages: cancelMessages,
      }),
    );
    const messages = (unwrapCommandUpdate(update).agentMessages as Overwrite<AIMessage[]>).value;
    const last = messages.at(-1);
    expect(last?.tool_calls?.[0]).toMatchObject({
      name: "present_availability_slots",
      args: { direction: "nearest", forceRefresh: true, durationMinutes: 30 },
    });
    expect(String(last?.tool_calls?.[0]?.id ?? "")).toMatch(/^booking_replace(?:ment)?_nearest_/);
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeUndefined();
  });

  it("routes post-slots replacement cancel to finalize, not mutation finalize", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: {
        id: "svc-botox",
        name: "Ботулінотерапія Botox 1 зона",
        source: "catalog",
        durationMinutes: 30,
      },
      accepted: true,
    });
    const agentMessages = [
      runtimeToolAi([{
          id: "cancel-1",
          name: "cancel_meeting",
          args: { meetingId: "m-1" },
          type: "tool_call" as const,
        }]),
      new ToolMessage({
        content: JSON.stringify({ success: true, id: "m-1", meetingId: "m-1" }),
        tool_call_id: "cancel-1",
        name: "cancel_meeting",
      }),
      runtimeToolAi([{
          id: "slots-1",
          name: "present_availability_slots",
          args: { direction: "nearest" },
          type: "tool_call" as const,
        }]),
      new ToolMessage({
        content: JSON.stringify({
          days: [
            {
              date: "2026-10-19",
              dayLabel: "19 жовтня (понеділок)",
              slots: [
                {
                  id: "2026-10-19T1130",
                  label: "11:30",
                  dateStart: "2026-10-19T11:30:00",
                  dateEnd: "2026-10-19T12:00:00",
                },
              ],
            },
            {
              date: "2026-10-20",
              dayLabel: "20 жовтня (вівторок)",
              slots: [
                {
                  id: "2026-10-20T1130",
                  label: "11:30",
                  dateStart: "2026-10-20T11:30:00",
                  dateEnd: "2026-10-20T12:00:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        }),
        tool_call_id: "slots-1",
        name: "present_availability_slots",
      }),
    ];
    expect(
      routeAfterAgentTools(
        clinicState({
          bookingDraft: draft,
          pendingInteraction: null,
          agentMessages,
        }),
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          finalizeName: "booking__finalize",
        }),
    ).toBe("booking__finalize");
  });

  it("finalize after replacement cancel+slots shows cancel note and date menu", async () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "service_selected",
      service: {
        id: "svc-botox",
        name: "Ботулінотерапія Botox 1 зона",
        source: "catalog",
        durationMinutes: 30,
      },
      accepted: true,
    });
    const agentMessages = [
      runtimeToolAi([{
          id: "cancel-1",
          name: "cancel_meeting",
          args: { meetingId: "m-1" },
          type: "tool_call" as const,
        }]),
      new ToolMessage({
        content: JSON.stringify({ success: true, id: "m-1", meetingId: "m-1" }),
        tool_call_id: "cancel-1",
        name: "cancel_meeting",
      }),
      runtimeToolAi([{
          id: "slots-1",
          name: "present_availability_slots",
          args: { direction: "nearest" },
          type: "tool_call" as const,
        }]),
      new ToolMessage({
        content: JSON.stringify({
          days: [
            {
              date: "2026-10-19",
              dayLabel: "19 жовтня (понеділок)",
              slots: [
                {
                  id: "2026-10-19T1130",
                  label: "11:30",
                  dateStart: "2026-10-19T11:30:00",
                  dateEnd: "2026-10-19T12:00:00",
                },
              ],
            },
            {
              date: "2026-10-20",
              dayLabel: "20 жовтня (вівторок)",
              slots: [
                {
                  id: "2026-10-20T1130",
                  label: "11:30",
                  dateStart: "2026-10-20T11:30:00",
                  dateEnd: "2026-10-20T12:00:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        }),
        tool_call_id: "slots-1",
        name: "present_availability_slots",
      }),
    ];
    const update = await createBookingFinalizeNode(bookingAgent)(
      clinicState({
        bookingDraft: draft,
        pendingInteraction: null,
        agentMessages,
      }),
    );
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeNull();
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("date_select");
    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
    expect(update.lastHandoff?.replyText).toMatch(/^Запис скасовано\.\n\n/);
    expect(update.lastHandoff?.replyText).not.toBe("Запис скасовано.");
    expect(update.lastHandoff?.replyButtons).not.toEqual([...DEFAULT_MENU_NO_VISITS]);
    expect(update.lastHandoff?.replyButtons?.length).toBeGreaterThan(0);
  });

  it("does not clear servicesContext when preparing booking", async () => {
    const prepare = createBookingPrepareNode();
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

  it("offeredServiceForTurn ignores typed CRM titles and lexical stems", async () => {
    const services = {
      list: [
        { id: "corr", name: "Корекція ботокс" },
        { id: "z1", name: "Ботулінотерапія Botox, Disport 1 зона" },
        { id: "z2", name: "Ботулінотерапія Botox, Disport 2 зони" },
        { id: "n1", name: "Ботулінотерапія Nabota 1 зона" },
      ],
    };
    expect(
      offeredServiceForTurn(
        clinicState({
          messages: [new HumanMessage("Корекція ботокс")],
          servicesContext: services,
        }),
        "faq",
        [],
      ),
    ).toBeNull();
    expect(
      offeredServiceForTurn(
        clinicState({
          messages: [new HumanMessage("botox")],
          servicesContext: services,
        }),
        "faq",
        [],
      ),
    ).toBeNull();
    expect(
      offeredServiceForTurn(
        clinicState({
          messages: [new HumanMessage("запиши на консультацію")],
          servicesContext: services,
        }),
        "faq",
        [],
      ),
    ).toBeNull();
  });

  it("passes full thread history including other agents' replies", async () => {
    const prepare = createBookingPrepareNode();
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

    const agentMessages = (unwrapCommandUpdate(update).agentMessages as Overwrite<unknown[]>).value;
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
    const prepare = createBookingPrepareNode();
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

    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toBeNull();
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.selectedAvailabilityDate).toBeUndefined();
  });

  it("folds a date after a pending consultation offer into the draft", async () => {
    const prepare = createBookingPrepareNode();
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

    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.status).toBe("accepted");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedDate).toBe("2026-10-16");
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.phase).toBe("time");
  });

  it.each([
    "потрібна консультація щодо ювідерм",
    "потрібна консультація щодо збільшення губ",
  ])(
    "does not rewrite Juvederm to Consultation when note orch owns: %s",
    async (patientText) => {
      const prepare = createBookingPrepareNode();
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

      expect(false).toBe(true);
      expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.service.id).toBe("svc-juvederm");
      expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.service.name).toBe("Juvederm");
      expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot?.dateStart).toBe("2026-10-19T12:00:00");
      expect(unwrapCommandUpdate(update).bookingDraft?.note.status).toBe("awaiting");
      expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
    },
  );

  it("applies a date onto a supervisor-seeded reschedule draft", async () => {
    const prepare = createBookingPrepareNode();
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

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      mode: "reschedule",
      phase: "time",
      selectedDate: "2026-10-23",
      rescheduleTarget: { id: "meeting-1" },
    });
  });

  it("opens a fresh session from an empty draft on «Записатись»", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        messages: [
          new AIMessage("Бажаєте записатися на консультацію?"),
          new HumanMessage("Записатись"),
        ],
        bookingDraft: {
          ...createEmptyBookingDraft(),
          version: 4,
          contactId: "stale-contact",
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      mode: "create",
      serviceAcceptance: {
        status: "pending",
        service: { id: CONSULTATION_SERVICE_ID },
      },
      selectedDate: null,
      selectedSlot: null,
      note: { status: "unasked" },
      pendingCommand: null,
      replacement: null,
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(unwrapCommandUpdate(update).bookingDraft?.contactId).not.toBe("stale-contact");
  });

  it("leaves a malformed draft untouched when the turn does not open a session", async () => {
    const prepare = createBookingPrepareNode();
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

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      version: 6,
      serviceAcceptance: null,
      selectedDate: "2026-10-16",
      note: { status: "answered", value: "біль" },
    });
    expect(update.bookingNoteStatus).toBeUndefined();
    expect(update.selectedSlot).toBeUndefined();
    expect(update.selectedAvailabilityDate).toBeUndefined();
  });

  it("does not open consultation from prose on a malformed draft", async () => {
    const prepare = createBookingPrepareNode();
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
        messages: [new HumanMessage("хочу консультацію")],
        bookingDraft: malformed,
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      version: 6,
      serviceAcceptance: null,
      selectedDate: "2026-10-16",
      note: { status: "answered", value: "біль" },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind ?? null).not.toBe("service_confirm");
  });
});



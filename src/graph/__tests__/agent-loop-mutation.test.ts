import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph";
import {
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createFaqFinalizeNode,
  createBookingFinalizeNode,
  advanceBookingNoteStep,
  bookingOutcomeRiskState,
  createAgentMutationFinalizeNode,
  classifyMeetingMutationToolMessage,
  createAgentToolsNode,
  crmWriteDirtiesPrefetch,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { setTrackEventForTests } from "../../analytics/track.js";
import {
  BOOKING_AWAITING_CONFIRM_UK,
  BOOKING_PHONE_QUESTION_UK,
  BOOKING_REPLACE_MENU,
  CLINIC_ADDRESS,
  CLINIC_MAPS_MARKDOWN,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  MAIN_MENU_GREETING_UK,
  MAIN_MENU_LABEL,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  VISIT_CHANGE_MENU,
  alreadyBookedReplaceReplyUk,
} from "../../shared/clinic-constants.js";
import {
  createEmptyBookingDraft,
} from "../booking-draft.js";
import type { BookingDraft } from "../booking-draft.js";
import { type ClinicAgentDefinition } from "../types.js";
import {
  canonicalBookingDraft,
  clinicState,
  makeListedMeetings,
  ownedContactContext,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";


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

  it("closes create and reschedule sessions on committed or declined outcomes", async () => {
    const finalize = createAgentMutationFinalizeNode(agent);
    for (const [name, content] of [
      ["create_meeting", { id: "m-1", success: true }],
      ["create_meeting", { cancelled: true }],
      ["reschedule_meeting", { id: "m-1", success: true }],
      ["reschedule_meeting", { cancelled: true }],
    ] as const) {
      const update = await finalize(clinicState({
        bookingDraft: canonicalBookingDraft(),
        agentMessages: mutationMessages(name, content),
      }));
      expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
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
          runtimeToolAi([{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }]),
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

  it("closes direct cancel on failed or blocked outcomes", async () => {
    const finalize = createAgentMutationFinalizeNode(agent);
    for (const content of [
      { error: "CRM unavailable" },
      { error: "Contact incomplete" },
    ]) {
      const update = await finalize(clinicState({
        bookingDraft: {
          ...createEmptyBookingDraft(),
          phase: "confirming",
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "m-1" },
          },
        },
        agentMessages: mutationMessages("cancel_meeting", content),
      }));
      expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    }
  });

  it("closes replacement cancel failures without replaying originalCommand", async () => {
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
    const update = await finalize(clinicState({
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
      agentMessages: mutationMessages("cancel_meeting", { error: "CRM unavailable" }),
    }));

    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
    expect(unwrapCommandUpdate(update).pendingCancellationPurpose).toBeNull();
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
          runtimeToolAi([{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }]),
        ],
      }),
      { configurable: {} },
    );
    expect(toolsUpdate.bookingDraft?.selectedSlot).toBeNull();
    expect(toolsUpdate.bookingDraft?.serviceAcceptance?.status).toBe("accepted");

    const finalUpdate = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: toolsUpdate.bookingDraft as BookingDraft,
      agentMessages: [
        runtimeToolAi([{ id: "c1", name: "create_meeting", args: {}, type: "tool_call" }]),
        (toolsUpdate.agentMessages as ToolMessage[])[0]!,
      ],
    }));
    expect(finalUpdate.bookingDraft).toBeNull();
  });

  it("ignores main-menu text while advancing the note step", async () => {
    expect(advanceBookingNoteStep(clinicState({
      messages: [new HumanMessage(MAIN_MENU_LABEL)],
      bookingDraft: canonicalBookingDraft({
        note: { status: "awaiting" },
      }),
    }))).toEqual({});
  });
});

describe("crmWriteDirtiesPrefetch", () => {
  it("is true for a successful CRM write tool result", async () => {
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

  it("is false for HITL pending, errors, and read tools", async () => {
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


describe("booking outcome risk: no model success text without a committed entity", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };
  const finalize = createBookingFinalizeNode(agent);
  const claims = [
    "Готово! Запис створено.",
    "Готово! Запис перенесено.",
    "Запис скасовано.",
    "Вас записано на консультацію.",
    "You are booked for tomorrow.",
  ] as const;

  const mutationTool = (
    name: "create_meeting" | "reschedule_meeting" | "cancel_meeting",
    content: unknown,
  ): [AIMessage, ToolMessage] => [
    new AIMessage({
      content: "",
      tool_calls: [{ id: "m1", name, args: {}, type: "tool_call" }],
    }),
    new ToolMessage({
      content: JSON.stringify(content),
      tool_call_id: "m1",
      name,
    }),
  ];

  it("treats non-committed mutation turns, details/confirming, and open confirm as risk", async () => {
    expect(bookingOutcomeRiskState(clinicState({
      agentMessages: [...mutationTool("create_meeting", { error: "CRM down" })],
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      agentMessages: [...mutationTool("create_meeting", { error: "Already booked", meetings: [] })],
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      agentMessages: [...mutationTool("create_meeting", { awaitingConfirmation: true })],
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      agentMessages: [...mutationTool("create_meeting", { error: "Contact incomplete" })],
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      bookingDraft: canonicalBookingDraft({ phase: "details" }),
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      bookingDraft: canonicalBookingDraft({ phase: "ready" }),
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        pendingCommand: { action: "create", payload: {} },
      }),
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [
          { id: "confirm", label: CONFIRM_YES_LABEL },
          { id: "decline", label: CONFIRM_NO_LABEL },
        ],
      },
    }))).toBe(true);
    expect(bookingOutcomeRiskState(clinicState({
      agentMessages: [new AIMessage("Де ви?")],
      bookingDraft: null,
    }))).toBe(false);
  });

  it.each(claims)("drops model claim on Already booked: %s", async (claim) => {
    const update = await finalize(clinicState({
      stepCount: 2,
      agentMessages: [
        ...mutationTool("create_meeting", {
          error: "Already booked",
          meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-09-04 11:00:00" }],
        }),
        new AIMessage(claim),
      ],
    }));
    expect(update.lastHandoff?.replyText).toContain("запланований візит");
    expect(update.lastHandoff?.replyText).not.toContain("Готово");
    expect(update.lastHandoff?.replyText).not.toContain("створено");
    expect(update.lastHandoff?.replyText).not.toContain("booked");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
  });

  it.each(claims)("drops model claim while HITL confirmation is pending: %s", async (claim) => {
    const update = await finalize(clinicState({
      stepCount: 2,
      contactContext: ownedContactContext(),
      bookingDraft: canonicalBookingDraft({
        phase: "confirming",
        pendingCommand: { action: "create", payload: {} },
      }),
      pendingInteraction: {
        kind: "mutation_confirm",
        action: "create",
        choices: [
          { id: "confirm", label: CONFIRM_YES_LABEL },
          { id: "decline", label: CONFIRM_NO_LABEL },
        ],
      },
      agentMessages: [
        ...mutationTool("create_meeting", { awaitingConfirmation: true }),
        new AIMessage(claim),
      ],
    }));
    expect(update.lastHandoff?.replyText).toBe(BOOKING_AWAITING_CONFIRM_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([CONFIRM_YES_LABEL, CONFIRM_NO_LABEL]);
  });

  it.each(claims)("drops model claim after blocked Contact incomplete: %s", async (claim) => {
    const update = await finalize(clinicState({
      stepCount: 2,
      bookingDraft: canonicalBookingDraft({ phase: "confirming", contactId: null }),
      agentMessages: [
        ...mutationTool("create_meeting", { error: "Contact incomplete" }),
        new AIMessage(claim),
      ],
    }));
    // detailsReady with unresolved contact → phone question owns the reply.
    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_QUESTION_UK);
    expect(update.lastHandoff?.replyText).not.toContain("Готово");
  });

  it.each(claims)("drops model claim after Not authorized block: %s", async (claim) => {
    const update = await finalize(clinicState({
      stepCount: 2,
      bookingDraft: canonicalBookingDraft({ phase: "confirming" }),
      contactContext: ownedContactContext(),
      agentMessages: [
        ...mutationTool("create_meeting", { error: "Not authorized" }),
        new AIMessage(claim),
      ],
    }));
    // Typed mutation_finalize owns Not authorized — never ship model success copy.
    expect(update.lastHandoff?.replyText).toBe(
      "Не вдалося створити запис через невідповідність даних. Ваші дані збережено.",
    );
    expect(update.lastHandoff?.replyText).not.toContain("Готово");
  });

  it.each(claims)("code-owns details-phase claim without a mutation: %s", async (claim) => {
    const update = await finalize(clinicState({
      bookingDraft: canonicalBookingDraft({ phase: "details", contactId: null }),
      agentMessages: [new HumanMessage("Продовжити без коментаря"), new AIMessage(claim)],
    }));
    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_QUESTION_UK);
  });

  it("ships address-only FAQ prose without false_success_claim rewrite", async () => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    try {
      const faqAgent: ClinicAgentDefinition = {
        id: "faq",
        name: "FAQ",
        description: "FAQ",
        systemPrompt: "faq",
        maxSteps: 4,
      };
      const address = `Ми за адресою:\n\n${CLINIC_ADDRESS}`;
      const update = await createFaqFinalizeNode(faqAgent)(clinicState({
        stepCount: 1,
        agentMessages: [new AIMessage(address)],
      }));
      expect(update.lastHandoff?.replyText).toBe(address);
      expect(seen.some((event) => event.name === "false_success_claim")).toBe(false);
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("rewrites uncommitted outcome claims to DEFAULT MENU and emits telemetry", async () => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    try {
      const update = await finalize(clinicState({
        stepCount: 1,
        bookingDraft: null,
        agentMessages: [new AIMessage("Готово! Запис створено.")],
      }));
      expect(update.lastHandoff?.replyText).toBe(MAIN_MENU_GREETING_UK);
      expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
      expect(seen).toContainEqual(
        expect.objectContaining({
          name: "false_success_claim",
          props: expect.objectContaining({ rule: "gotovo", agent: "booking" }),
        }),
      );
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("does not ship create success after Main menu closed the draft", async () => {
    const { claimsOutcome } = await import("../../shared/outcome-claims.js");
    const update = await finalize(clinicState({
      stepCount: 1,
      bookingDraft: null,
      pendingInteraction: null,
      messages: [new HumanMessage("+380 50 832 4221")],
      agentMessages: [new AIMessage("Запис успішно створено.")],
    }));
    expect(claimsOutcome(update.lastHandoff?.replyText ?? "")).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(MAIN_MENU_GREETING_UK);
  });

  it("renders a code-owned Already booked label from the tool payload", async () => {
    const update = await finalize(clinicState({
      stepCount: 2,
      agentMessages: [
        ...mutationTool("create_meeting", {
          error: "Already booked",
          meetings: [{
            id: "m-1",
            name: "Консультація - Ada",
            dateStart: "2026-09-04T11:00:00",
          }],
        }),
        new AIMessage("booked"),
      ],
    }));
    expect(update.lastHandoff?.replyText).toContain(alreadyBookedReplaceReplyUk().slice(0, 20));
    expect(update.lastHandoff?.replyText).toMatch(/Консультація/);
  });
});

describe("runtime-owned create/reschedule success copy", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  const mutationMessages = (
    name: "create_meeting" | "reschedule_meeting",
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

  it("renders committed create from tool visitLabel", () => {
    const visitLabel = "Консультація — 10 вересня (четвер) о 14:00";
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: null,
      agentMessages: mutationMessages("create_meeting", {
        id: "m-new",
        success: true,
        visitLabel,
      }),
    }));

    expect(update.lastHandoff?.replyText).toBe(
      `Готово! Запис створено.\n\n${visitLabel} ✨`
      + `\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`
      + "\n\nПереглянути або змінити візит можна в «Мій запис».",
    );
    expect(update.lastHandoff?.replyText).not.toContain("Ada");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("ignores raw name/dateStart on the tool JSON without visitLabel", () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: null,
      agentMessages: mutationMessages("create_meeting", {
        id: "m-new",
        name: "Консультація - Ada",
        dateStart: "2026-09-10 14:00:00",
      }),
    }));

    expect(update.lastHandoff?.replyText).toMatch(/^Готово! Запис створено\./);
    expect(update.lastHandoff?.replyText).not.toContain("Консультація");
    expect(update.lastHandoff?.replyText).not.toContain("Ada");
    expect(update.lastHandoff?.replyText).toContain(CLINIC_ADDRESS);
    expect(update.lastHandoff?.replyText).toContain("Мій запис");
  });

  it("renders committed create without inventing details when visitLabel is absent", () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: null,
      agentMessages: mutationMessages("create_meeting", {
        id: "m-new",
        success: true,
      }),
    }));

    expect(update.lastHandoff?.replyText).toMatch(/^Готово! Запис створено\./);
    expect(update.lastHandoff?.replyText).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(update.lastHandoff?.replyText).toContain(CLINIC_ADDRESS);
    expect(update.lastHandoff?.replyText).toContain("Мій запис");
  });

  it("renders committed reschedule from tool visitLabel", () => {
    const visitLabel = "Консультація — 10 вересня (четвер) о 14:00";
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingDraft: null,
      agentMessages: mutationMessages("reschedule_meeting", {
        id: "m-1",
        success: true,
        visitLabel,
      }),
    }));

    expect(update.lastHandoff?.replyText).toBe(
      `Готово! Запис перенесено.\n\n${visitLabel} ✨`
      + `\n\nАдреса: ${CLINIC_ADDRESS}\n${CLINIC_MAPS_MARKDOWN}`
      + "\n\nПереглянути або змінити візит можна в «Мій запис».",
    );
    expect(update.lastHandoff?.replyText).toMatch(/^Готово! Запис перенесено/);
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
    runtimeToolAi([{ id: "cancel-1", name: "cancel_meeting", args: { meetingId: "m-1" } }]),
    new ToolMessage({
      content: JSON.stringify(content),
      tool_call_id: "cancel-1",
      name: "cancel_meeting",
    }),
  ];

  it("classifies cancellation decline separately from pending confirmation", async () => {
    expect(classifyMeetingMutationToolMessage(cancellationMessages({ cancelled: true })[1]))
      .toBe("declined");
    expect(classifyMeetingMutationToolMessage(new ToolMessage({
      content: JSON.stringify({ awaitingConfirmation: true }),
      tool_call_id: "pending-1",
      name: "cancel_meeting",
    }))).toBe("pending_confirmation");
  });

  it("renders a declined cancellation with an actionable visit-change menu", async () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      messages: [new HumanMessage("❌")],
      bookingContext: makeListedMeetings(),
      agentMessages: cancellationMessages({ cancelled: true }),
    }));

    expect(update.lastHandoff).toMatchObject({
      status: "ok",
      replyText: "Запис не було скасовано.",
      replyButtons: [...VISIT_CHANGE_MENU],
    });
    expect(unwrapCommandUpdate(update).bookingDraft).toBeNull();
  });

  it("renders committed cancellation without model-authored success text", async () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingContext: makeListedMeetings(),
      agentMessages: cancellationMessages({ id: "m-1", success: true }),
    }));

    expect(update.lastHandoff?.replyText).toBe("Запис скасовано.");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("renders a replacement cancellation decline with the default booking menu", async () => {
    const update = createAgentMutationFinalizeNode(agent)(clinicState({
      bookingContext: makeListedMeetings(),
      agentMessages: cancellationMessages({ cancelled: true }),
    }));

    expect(update.lastHandoff).toMatchObject({
      status: "ok",
      replyText: "Скасування поточного візиту скасовано. Новий запис не було створено.",
      replyButtons: [...DEFAULT_MENU_HAS_VISITS],
    });
  });

  it("routes terminal direct cancellation outcomes around the booking LLM", async () => {
    expect(routeAfterAgentTools(
      clinicState({
        bookingContext: makeListedMeetings(),
        agentMessages: cancellationMessages({ cancelled: true }),
      }),
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
        })).toBe("booking__mutation_finalize");
  });

  it("routes a declined replacement cancellation to runtime finalization", async () => {
    expect(routeAfterAgentTools(
      clinicState({
        bookingContext: makeListedMeetings(),
        agentMessages: cancellationMessages({ cancelled: true }),
      }),
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
        })).toBe("booking__mutation_finalize");
  });

  it("routes a typed reschedule decline directly to deterministic finalization", async () => {
    // Adapter maps NL decline to { confirmed: false } → cancelled tool result.
    const state = clinicState({
      bookingContext: makeListedMeetings(),
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
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
        })).toBe("booking__mutation_finalize");

    const declined = createAgentMutationFinalizeNode(agent)(state);
    expect(declined).not.toBeInstanceOf(Command);
    expect(declined).toMatchObject({
      lastHandoff: {
        status: "ok",
        replyText: "Запис не було перенесено.",
      },
      bookingDraft: null,
    });
    expect((declined as { lastHandoff?: { replyText?: string } }).lastHandoff?.replyText)
      .not.toContain("вільні");
  });

  it("routes main-menu leave to mutation finalize, which hands off to the supervisor", async () => {
    for (const [mutationName, draft, purpose] of [
      [
        "reschedule_meeting",
        canonicalBookingDraft({
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
        null,
      ],
      [
        "create_meeting",
        canonicalBookingDraft({
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            },
          },
        }),
        null,
      ],
      [
        "cancel_meeting",
        canonicalBookingDraft({
          phase: "confirming",
          pendingCommand: {
            action: "cancel",
            payload: { meetingId: "m-1" },
          },
        }),
        "direct" as const,
      ],
    ] as const) {
      const state = clinicState({
        bookingContext: makeListedMeetings(),
        bookingDraft: draft,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              cancelled: true,
              left: true,
              message: "Cancelled by user.",
            }),
            tool_call_id: `${mutationName}-leave`,
            name: mutationName,
          }),
        ],
      });

      expect(routeAfterAgentTools(
        state,
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
        })).toBe("booking__mutation_finalize");

      const finalized = createAgentMutationFinalizeNode(agent)(state);
      expect(finalized).toBeInstanceOf(Command);
      const command = finalized as Command;
      expect(command.goto).toEqual(["supervisor"]);
      expect(command.update).toMatchObject({
        bookingDraft: null,
        pendingInteraction: null,
        lastHandoff: null,
      });
    }
  });

  it("routes an abandoned replacement cancellation to the supervisor", async () => {
    const state = clinicState({
      bookingContext: makeListedMeetings(),
      bookingDraft: canonicalBookingDraft({
        mode: "replace",
        phase: "confirming",
        pendingCommand: {
          action: "cancel",
          payload: { meetingId: "m-1" },
        },
        replacement: {
          meeting: { id: "m-1" },
          status: "cancelling",
          originalCommand: {
            action: "create",
            payload: {
              serviceId: "svc-1",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            },
          },
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({ cancelled: true, left: true }),
          tool_call_id: "cancel-leave",
          name: "cancel_meeting",
        }),
      ],
    });

    expect(routeAfterAgentTools(
      state,
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
        })).toBe("booking__mutation_finalize");

    const finalized = createAgentMutationFinalizeNode(agent)(state);
    expect(finalized).toBeInstanceOf(Command);
    expect((finalized as Command).goto).toEqual(["supervisor"]);
  });

  it("routes HITL other-reply after skip to the booking LLM, not the note orchestrator", async () => {
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
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          noteOrchestratorName: "booking__note_orch",
        })).toBe("booking__llm");
  });

  it("still routes HITL other-reply to note orch while keep/switch is open", async () => {
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
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          noteOrchestratorName: "booking__note_orch",
        })).toBe("booking__note_orch");
  });

  it("still sends declined HITL chat to mutation finalize, not the note orch", async () => {
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
        {
          llmName: "booking__llm",
          toolsName: "booking__tools",
          mutationFinalizeName: "booking__mutation_finalize",
          commandPrepareName: "booking__command_prepare",
          noteOrchestratorName: "booking__note_orch",
        })).toBe("booking__mutation_finalize");
  });
});



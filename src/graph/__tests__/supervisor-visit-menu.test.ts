import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Overwrite } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setTrackEventForTests } from "../../analytics/track.js";
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
  isVisitStatusSignal,
  serviceConfirmPending,
  stickyContinueAgentId,
  supervisorState,
} from "./supervisor-fixtures.js";

describe("createClinicSupervisorNode visit-change sticky", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    invoke.mockResolvedValue({ next: "faq", reply: "should not be used" });
  });

  it("skips the LLM and routes Скасувати to booking after a FINISH visit list", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      bookingContext: {
        meetings: [
          {
            id: "m-1",
            name: "Консультація - Ada",
            dateStart: "2026-08-21 11:00:00",
            dateEnd: "2026-08-21 11:30:00",
          },
        ],
        dateFrom: "2026-08-11",
      },
    }));
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        bookingContext: {
          meetings: [
            {
              id: "m-1",
              name: "Консультація - Ada",
              dateStart: "2026-08-21 11:00:00",
              dateEnd: "2026-08-21 11:30:00",
            },
          ],
          dateFrom: "2026-08-11",
        },
        lastHandoff: {
          agentId: "FINISH",
          agentName: "supervisor",
          status: "ok",
        },
        messages: [
          new AIMessage("Заплановані візити: консультація — 21 серпня о 11:00 🗓️"),
          new HumanMessage("Скасувати"),
        ],
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledOnce();
    expect(update).toMatchObject({
      next: "booking",
      lastHandoff: null,
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
    });
  });

  it("keeps reschedule intent when the patient answers the visit list with a date", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
      bookingContext: {
        meetings: [
          {
            id: "m-1",
            name: "Консультація - Ada",
            dateStart: "2026-08-21 11:00:00",
            dateEnd: "2026-08-21 11:30:00",
          },
        ],
        dateFrom: "2026-08-11",
      },
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
          agentId: "FINISH",
          agentName: "supervisor",
          status: "ok",
        },
        pendingInteraction: {
          kind: "visit_select",
          stage: "action",
          meetingId: "m-1",
          meetings: [
            {
              id: "m-1",
              name: "Консультація - Ada",
              dateStart: "2026-08-21 11:00:00",
              dateEnd: "2026-08-21 11:30:00",
            },
          ],
          choices: [
            { id: "reschedule", label: "Перенести" },
            { id: "cancel", label: "Скасувати" },
            { id: "decline", label: "Ні, дякую" },
          ],
        },
        messages: [
          new AIMessage("Заплановані візити: консультація — 21 серпня о 11:00"),
          new HumanMessage("23 жовтня"),
        ],
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        bookingContext: {
          meetings: [
            {
              id: "m-1",
              name: "Консультація - Ada",
              dateStart: "2026-08-21 11:00:00",
              dateEnd: "2026-08-21 11:30:00",
            },
          ],
          dateFrom: "2026-08-11",
        },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(update).toMatchObject({
      next: "booking",
      availabilityContext: null,
      availabilityCursor: null,
      bookingDraft: {
        mode: "reschedule",
        rescheduleTarget: { id: "m-1" },
      },
    });
    expect(update.lastHandoff).toBeUndefined();
  });
});

describe("createClinicSupervisorNode code-owned FINISH menus", () => {
  it.each([
    "Перенеси мій запис на 16 число",
    "Скасуй мій запис",
    "Please reschedule my visit",
    "Book my visit for Monday",
  ])("does not treat visit-action free text as a pre-LLM status signal: %s", (text) => {
    expect(isVisitStatusSignal(text)).toBe(false);
  });

  it.each([
    "Мій запис",
    "Я вже записалася — перевірте",
    "I already booked an appointment",
  ])("keeps appointment assertions as a pre-LLM status signal: %s", (text) => {
    expect(isVisitStatusSignal(text)).toBe(true);
  });

  it.each([
    "Do I have an appointment?",
    "What visits do I have?",
  ])("defers soft visit-status questions to the model intent: %s", (text) => {
    expect(isVisitStatusSignal(text)).toBe(false);
  });

  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;

  const meetings = {
    meetings: [
      {
        id: "m-1",
        name: "Консультація - Ada",
        dateStart: "2026-08-21 11:00:00",
        dateEnd: "2026-08-21 11:30:00",
      },
    ],
    dateFrom: "2026-08-11",
  };

  const visitAsk =
    "Заплановані візити:\n🗓️ Консультація - 21 серпня (п'ятниця) о 11:00\n\nБажаєте перенести або скасувати цей візит?";

  it.each([
    "Я вже записалася на 16 число",
    "Я же уже записалась на 16 число",
    "У мене вже є запис?",
    "I already booked an appointment",
  ])("owns visit-status assertion %s even when the model routes to FAQ", async (text) => {
    invoke.mockResolvedValue({ next: "faq", reply: "У вас точно є запис." });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: { contacts: [] },
        bookingContext: { meetings: [], dateFrom: "2026-08-11" },
      }),
    });

    const update = await node(supervisorState({ messages: [new HumanMessage(text)] }));

    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.replyText).toContain("не знайдено");
    expect(update.lastHandoff?.replyText).not.toContain("точно є");
    expect(update.lastHandoff?.replyButtons).toEqual(DEFAULT_MENU_NO_VISITS);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("handles soft visit-status via model intent=visit_status after a forced refetch", async () => {
    const prefetch = vi.fn(async () => ({
      contactContext: { contacts: [] },
      bookingContext: { meetings: [], dateFrom: "2026-08-11" },
    }));
    invoke.mockResolvedValue({ next: "faq", intent: "visit_status", reply: "У вас точно є запис." });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch,
    });

    const update = await node(
      supervisorState({
        messages: [new HumanMessage("Do I have an appointment?")],
        contactContext: { contacts: [{ id: "c-1" }] },
        bookingContext: meetings,
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(prefetch).toHaveBeenCalledOnce();
    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.replyText).toContain("не знайдено");
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("reports unverifiable status when the fresh prefetch fails", async () => {
    invoke.mockResolvedValue({ next: "faq", reply: "Так, ваш запис підтверджено." });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => { throw new Error("CRM down"); },
    });

    const update = await node(supervisorState({
      messages: [new HumanMessage("I already booked an appointment")],
    }));

    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.replyText).toContain("перевірити");
    expect(update.lastHandoff?.replyText).not.toContain("підтверджено");
    expect(update.lastHandoff?.replyButtons).toEqual(DEFAULT_MENU_NO_VISITS);
    expect(invoke).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
  });

  const nodeWithPrefetch = (bookingContext: typeof meetings | null) =>
    createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        bookingContext,
      }),
    });

  it("attaches VISIT_CHANGE after «Мій запис» when visits exist (ignores wrong menu=default)", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: visitAsk,
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "ok",
      replyText: visitAsk,
      replyButtons: [...VISIT_CHANGE_MENU],
    });
  });

  it("marks a single-visit status response for a direct date/time reschedule", async () => {
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "action",
      meetingId: meetings.meetings[0]!.id,
    });
  });

  const twoMeetings = {
    meetings: [
      {
        id: "m-1",
        name: "Консультація - Ada",
        dateStart: "2026-08-21 11:00:00",
        dateEnd: "2026-08-21 11:30:00",
      },
      {
        id: "m-2",
        name: "Ботулінотерапія - Ada",
        dateStart: "2026-08-28 15:00:00",
        dateEnd: "2026-08-28 15:30:00",
      },
    ],
    dateFrom: "2026-08-11",
  };

  it("shows Move/Cancel after «Мій запис» with 2+ visits (does not imply reschedule)", async () => {
    const update = await nodeWithPrefetch(twoMeetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "action",
    });
    expect(update.pendingInteraction).not.toHaveProperty("meetingId");
    expect(update.lastHandoff?.replyButtons).toEqual([...VISIT_CHANGE_MENU]);
    expect(update.lastHandoff?.replyText).not.toContain("Який візит перенести?");
    expect(update.lastHandoff?.replyText).not.toContain("Який візит скасувати?");
  });

  it("opens a meeting picker after Перенести with 2+ visits, then starts reschedule", async () => {
    const status = await nodeWithPrefetch(twoMeetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );
    const afterMove = await nodeWithPrefetch(twoMeetings)(
      supervisorState({
        messages: [new HumanMessage("Перенести")],
        pendingInteraction: status.pendingInteraction ?? null,
        bookingContext: twoMeetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(afterMove.next).toBe("FINISH");
    expect(afterMove.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "meeting",
      action: "reschedule",
    });
    expect(afterMove.lastHandoff?.replyText).toBe("Який візит перенести?");
    expect(afterMove.lastHandoff?.replyButtons).toEqual(
      twoMeetings.meetings.map((m) => visitMeetingChoiceLabel(m)),
    );

    const label = visitMeetingChoiceLabel(twoMeetings.meetings[0]!);
    const afterPick = await nodeWithPrefetch(twoMeetings)(
      supervisorState({
        messages: [new HumanMessage(label)],
        pendingInteraction: afterMove.pendingInteraction ?? null,
        bookingContext: twoMeetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(afterPick.next).toBe("booking");
    expect(afterPick.bookingDraft).toMatchObject({
      mode: "reschedule",
      rescheduleTarget: { id: "m-1" },
    });
    expect(afterPick.pendingInteraction).toBeNull();
  });

  it("opens a meeting picker after Скасувати with 2+ visits, then prepares cancel_meeting", async () => {
    const status = await nodeWithPrefetch(twoMeetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );
    const afterCancel = await nodeWithPrefetch(twoMeetings)(
      supervisorState({
        messages: [new HumanMessage("Скасувати")],
        pendingInteraction: status.pendingInteraction ?? null,
        bookingContext: twoMeetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(afterCancel.next).toBe("FINISH");
    expect(afterCancel.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "meeting",
      action: "cancel",
    });
    expect(afterCancel.lastHandoff?.replyText).toBe("Який візит скасувати?");

    const label = visitMeetingChoiceLabel(twoMeetings.meetings[1]!);
    const afterPick = await nodeWithPrefetch(twoMeetings)(
      supervisorState({
        messages: [new HumanMessage(label)],
        pendingInteraction: afterCancel.pendingInteraction ?? null,
        bookingContext: twoMeetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(afterPick.next).toBe("booking");
    expect(afterPick.bookingDraft?.pendingCommand).toMatchObject({
      action: "cancel",
      payload: { meetingId: "m-2" },
    });

    const commandPrepare = createAgentCommandPrepareNode("booking");
    const prepared = await commandPrepare(
      supervisorState({
        messages: [new HumanMessage(label)],
        bookingDraft: afterPick.bookingDraft ?? null,
        bookingContext: twoMeetings,
        pendingInteraction: null,
        agentMessages: [new HumanMessage(label)],
      }),
    );

    expect(prepared.agentMessages).toBeInstanceOf(Overwrite);
    const preparedMessages = (prepared.agentMessages as Overwrite<AIMessage[]>).value;
    const ai = [...preparedMessages].reverse().find((m) => (m.tool_calls?.length ?? 0) > 0);
    expect(ai).toMatchObject({
      tool_calls: [
        expect.objectContaining({
          name: "cancel_meeting",
          args: expect.objectContaining({ meetingId: "m-2" }),
        }),
      ],
    });
    expect(prepared.pendingInteraction?.kind).toBe("mutation_confirm");
  });

  it("clears a seeded cancel pendingCommand on a later free-text turn", async () => {
    const seeded = createEmptyBookingDraft();
    seeded.pendingCommand = {
      action: "cancel",
      payload: { meetingId: "m-2", confirmMessage: "Скасувати цей візит?" },
    };
    invoke.mockResolvedValue({
      next: "faq",
      reply: "",
    });
    const update = await nodeWithPrefetch(twoMeetings)(
      supervisorState({
        messages: [new HumanMessage("скільки коштує ботокс?")],
        bookingDraft: seeded,
        bookingContext: twoMeetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );

    expect(update.bookingDraft?.pendingCommand).toBeNull();
  });

  it("replaces a stale «Мій запис» list with prefetch labels", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply:
        "Заплановані візити:\n🗓️ Консультація — завтра, 3 вересня (четвер) о 15:05\n\nБажаєте перенести або скасувати цей візит?",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyText).toBe(visitAsk);
    expect(update.messages).toEqual([expect.objectContaining({ content: visitAsk })]);
  });

  it("injects prefetch visits on «Головне меню» even when the model omitted the heading", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Привіт, Ada! Я ШІ-асистент.\n\nЧим можу допомогти?",
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
    expect(update.lastHandoff?.replyText).toContain("Чим можу допомогти?");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });


  it("attaches DEFAULT has-visits after «Головне меню» even when menu=visit_change", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Привіт! У вас є запланований візит. Чим можу допомогти?",
      menu: "visit_change",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
  });

  it("falls back to DEFAULT no-visits when «Мій запис» but list is empty", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Зараз не бачу запланованих візитів. Можу допомогти записатися?",
      menu: "visit_change",
    });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("attaches DEFAULT has-visits for menu=default when visits exist", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Будь ласка! Чим ще можу допомогти?",
      menu: "default",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("дякую")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toBe("Будь ласка! Чим ще можу допомогти?");
    expect(update.lastHandoff?.replyText).not.toContain("Заплановані візити:");
  });

  it("attaches DEFAULT no-visits when menu is omitted on FINISH", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт! Чим можу допомогти?" });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("привіт")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("attaches VISIT_CHANGE when menu is omitted after «Мій запис» and visits exist", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: visitAsk });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...VISIT_CHANGE_MENU]);
  });

  it("builds visit list when FINISH omits reply on «Мій запис»", async () => {
    invoke.mockResolvedValue({ next: "FINISH", menu: "visit_change" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "ok",
      replyText: visitAsk,
      replyButtons: [...VISIT_CHANGE_MENU],
    });
    expect(update.messages).toEqual([expect.objectContaining({ content: visitAsk })]);
  });

  it("attaches DEFAULT has-visits when menu is omitted on Головне меню and visits exist", async () => {
    invoke.mockResolvedValue({ next: "FINISH", reply: "Привіт! Чим можу допомогти?" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage(MAIN_MENU_LABEL)] }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
    expect(update.lastHandoff?.replyText).toContain("🗓️ Консультація - 21 серпня (п'ятниця) о 11:00");
    expect(update.lastHandoff?.replyText).toContain("Чим можу допомогти?");
  });

  it("strips a stray model trailer and still uses code-owned menu labels", async () => {
    invoke.mockResolvedValue({
      next: "FINISH",
      reply:
        "Привіт, Тест!\n\n<reply_buttons>\nWrong\nLabels\n</reply_buttons>",
      menu: "default",
    });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("Головне меню")] }),
    );

    expect(update.lastHandoff?.replyText).toBe("Привіт, Тест!");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
  });

  it("delivers routing failure via handoff only", async () => {
    const { PATIENT_FALLBACK_MESSAGE } = await import("../../shared/clinic-constants.js");
    invoke.mockResolvedValue({ next: "FINISH" });
    const update = await nodeWithPrefetch(null)(
      supervisorState({ messages: [new HumanMessage("???")] }),
    );

    expect(update.messages).toBeUndefined();
    expect(update.lastHandoff).toMatchObject({
      agentId: "FINISH",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: [...DEFAULT_MENU_NO_VISITS],
    });
  });

  it("maps model choiceId decline on open visit_select", async () => {
    const status = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Добре.",
      choiceId: "decline",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({
        messages: [new HumanMessage("ні, дякую")],
        pendingInteraction: status.pendingInteraction ?? null,
        bookingContext: meetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );
    expect(invoke).toHaveBeenCalled();
    expect(update.pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(VISIT_DECLINE_REPLY_UK);
  });

  it("ignores a model choiceId that is not on the open visit menu", async () => {
    const status = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("Мій запис")] }),
    );
    invoke.mockResolvedValue({
      next: "FINISH",
      reply: "Чим можу допомогти?",
      choiceId: "not-a-real-id",
    });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({
        messages: [new HumanMessage("хм, не знаю")],
        pendingInteraction: status.pendingInteraction ?? null,
        bookingContext: meetings,
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        prefetchFetchedAt: Date.now(),
      }),
    );
    expect(update.next).toBe("FINISH");
    expect(update.lastHandoff?.replyText).toBe("Чим можу допомогти?");
    expect(update.bookingDraft?.pendingCommand ?? null).toBeNull();
  });

  it("ignores a model choiceId for interactions owned by a specialist", async () => {
    invoke.mockResolvedValue({ next: "booking", choiceId: "choose_other" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({
        messages: [new HumanMessage("а що ще у вас є крім цього")],
        pendingInteraction: {
          kind: "service_confirm",
          service: { id: CONSULTATION_SERVICE_ID, name: "Консультація", source: "catalog" },
          choices: [
            { id: "accept", label: "Так" },
            { id: "choose_other", label: "Обрати іншу процедуру" },
          ],
        },
      }),
    );
    expect(update.pendingInteraction?.kind).not.toBe("catalog_detour");
  });

  it("routes visit_cancel intent to booking with a seeded cancel draft", async () => {
    invoke.mockResolvedValue({ next: "faq", intent: "visit_cancel" });
    const update = await nodeWithPrefetch(meetings)(
      supervisorState({ messages: [new HumanMessage("скасуй мій візит будь ласка")] }),
    );
    expect(update.next).toBe("booking");
    expect(update.bookingDraft?.pendingCommand).toMatchObject({
      action: "cancel",
      payload: { meetingId: "m-1" },
    });
  });

  it("opens the meeting picker for visit_cancel intent with 2+ visits", async () => {
    invoke.mockResolvedValue({ next: "booking", intent: "visit_cancel" });
    const update = await nodeWithPrefetch(twoMeetings)(
      supervisorState({ messages: [new HumanMessage("хочу скасувати візит")] }),
    );
    expect(update.next).toBe("FINISH");
    expect(update.pendingInteraction).toMatchObject({
      kind: "visit_select",
      stage: "meeting",
      action: "cancel",
    });
    expect(update.lastHandoff?.replyText).toBe("Який візит скасувати?");
    expect(update.bookingDraft?.pendingCommand ?? null).toBeNull();
  });

  it("does not seed a mutation when visit_cancel intent has no planned visit", async () => {
    invoke.mockResolvedValue({ next: "booking", intent: "visit_cancel" });
    const update = await nodeWithPrefetch({ meetings: [], dateFrom: "2026-08-11" })(
      supervisorState({ messages: [new HumanMessage("скасуйте мій запис")] }),
    );
    expect(update.next).toBe("booking");
    expect(update.bookingDraft?.pendingCommand ?? null).toBeNull();
  });
});

describe("supervisor_routing_decision telemetry", () => {
  const invoke = vi.fn();
  const bindRoutingTools = vi.fn(() => ({ invoke }));
  const supervisorLlm = { bindRoutingTools } as unknown as ILLMConnector;
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];

  beforeEach(() => {
    invoke.mockReset();
    bindRoutingTools.mockClear();
    events.length = 0;
    setTrackEventForTests((name, props) => {
      events.push({ name, props: props ?? {} });
    });
  });

  afterEach(() => {
    setTrackEventForTests(null);
  });

  const routingEvents = () =>
    events.filter((event) => event.name === "supervisor_routing_decision");

  it("emits exactly one event on a pre-LLM status path", async () => {
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        bookingContext: {
          meetings: [
            {
              id: "m-1",
              name: "Консультація",
              dateStart: "2026-08-21 11:00:00",
              dateEnd: "2026-08-21 11:30:00",
            },
          ],
          dateFrom: "2026-08-11",
        },
      }),
    });
    await node(supervisorState({ messages: [new HumanMessage("Мій запис")] }));
    expect(invoke).not.toHaveBeenCalled();
    expect(routingEvents()).toHaveLength(1);
    expect(routingEvents()[0]?.props).toMatchObject({
      path: "status_pre_llm",
      regexStatusSignal: true,
      next: "FINISH",
    });
  });

  it("emits exactly one event on a post-LLM path", async () => {
    invoke.mockResolvedValue({ next: "faq", intent: "faq", reply: "Ось відповідь" });
    const node = createClinicSupervisorNode({
      agents,
      supervisorLlm,
      loadSupervisorPrompt: () => "STATIC",
      prefetch: async () => ({
        contactContext: { contacts: [{ id: "c-1", firstName: "Ada" }] },
        bookingContext: { meetings: [], dateFrom: "2026-08-11" },
      }),
    });
    await node(supervisorState({ messages: [new HumanMessage("яка адреса?")] }));
    expect(invoke).toHaveBeenCalledOnce();
    expect(routingEvents()).toHaveLength(1);
    expect(routingEvents()[0]?.props).toMatchObject({
      path: "llm",
      intent: "faq",
      next: "faq",
    });
  });
});


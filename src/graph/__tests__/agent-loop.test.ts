import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentFinalizeNode, createAgentPrepareNode, captureAvailabilityFromMessages, captureServicesFromMessages, classifyMeetingMutationToolMessage, createAgentToolsNode, crmWriteDirtiesPrefetch, meetingMutationClearsAvailability } from "../agent-loop.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  formatAvailabilityContext,
  formatBookingMeetingsContext,
  formatContactContext,
  formatPlannedVisitsFlag,
  formatServicesContext,
  formatSupervisorVisitLabels,
} from "../context-blocks.js";
import type { ContactLookupContext } from "../../tools/contact-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import type { ClinicState } from "../state.js";
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

const clinicState = (overrides: Partial<ClinicState> = {}): ClinicState => ({
  messages: [],
  agentMessages: [],
  stepCount: 0,
  next: undefined,
  lastHandoff: null,
  bookingContext: null,
  contactContext: null,
  availabilityContext: null,
  servicesContext: null,
  prefetchDirty: false,
  prefetchFetchedAt: null,
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

describe("formatBookingMeetingsContext", () => {
  it("returns an empty string when context is missing", () => {
    expect(formatBookingMeetingsContext(null)).toBe("");
  });

  it("renders an empty meetings list so the model does not re-fetch", () => {
    const block = formatBookingMeetingsContext({ meetings: [], dateFrom: "2026-08-11" });
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain('"meetings":[]');
    expect(block).not.toContain("When moving or cancelling");
  });

  it("wraps the list payload for uncached system metadata", () => {
    const block = formatBookingMeetingsContext(listedMeetings);
    expect(block).toContain("<list_planned_meetings>");
    expect(block).toContain("</list_planned_meetings>");
    expect(block).toContain('"id":"m-1"');
    expect(block).toContain('"dateStart":"2026-08-17 11:00:00"');
    expect(block).toContain('"dateFrom":"2026-08-11"');
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
  it("emits only has/none", () => {
    expect(formatPlannedVisitsFlag(null)).toBe(
      "<planned_visits>none</planned_visits>",
    );
    expect(formatPlannedVisitsFlag({ meetings: [], dateFrom: "2026-08-11" })).toBe(
      "<planned_visits>none</planned_visits>",
    );
    expect(formatPlannedVisitsFlag(listedMeetings)).toBe(
      "<planned_visits>has</planned_visits>",
    );
  });
});

describe("formatSupervisorVisitLabels", () => {
  it("emits visitLabels only", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T09:00:00Z"));
      const block = formatSupervisorVisitLabels(listedMeetings);
      expect(block).toContain('"visitLabels"');
      expect(block).toContain("Консультація - 17 серпня (понеділок) о 11:00");
      expect(block).not.toContain('"id"');
      expect(block).not.toContain('"dateStart"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an empty string when context is missing", () => {
    expect(formatSupervisorVisitLabels(null)).toBe("");
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
    expect(update.servicesContext).toBeNull();
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
          content: JSON.stringify({ awaitingConfirmation: true }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("pending");
  });

  it("clears availability on committed or failed meeting mutations only", () => {
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

  it("does not capture servicesContext from list_services on booking", async () => {
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

    expect(update.servicesContext).toBeUndefined();
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
      "DYNAMIC KYIV\n\n<planned_visits>none</planned_visits>",
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
    expect(String(faqDynamic.content)).not.toContain("<list_planned_meetings>");
    expect(String(faqDynamic.content)).not.toContain("<availability>");
    expect(String(faqDynamic.content)).not.toContain("<list_services>");
    expect(bookingDynamic.content).toContain("DYNAMIC KYIV");
    expect(bookingDynamic.content).toContain(formatContactContext(listedContact));
    expect(bookingDynamic.content).toContain(formatBookingMeetingsContext(listedMeetings));
    expect(String(bookingDynamic.content)).toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
  });

  it("appends list_services to FAQ only, never to booking", async () => {
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
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
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

  it("keeps availability block when a different tool ran this turn", async () => {
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
    expect(String(bookingDynamic.content)).toContain("<availability>");
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

describe("createAgentFinalizeNode", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("strips reply_buttons from checkpointed history and stores labels on lastHandoff", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "Підібрати вільний час на консультацію?\n\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Підібрати вільний час на консультацію?");
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "booking",
      status: "ok",
      replyButtons: ["Так", "Обрати іншу процедуру"],
    });
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
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
        agentMessages: [
          new AIMessage(
            "Записати вас на консультацію?\n<yield_to_supervisor/>\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Записати вас на консультацію?");
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyButtons: ["Так", "Обрати іншу процедуру"],
      yieldToSupervisor: true,
    });
  });

  it("strips a yield-only trailer with no reply_buttons", () => {
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
        agentMessages: [new AIMessage("Done.\n<yield_to_supervisor/>")],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Done.");
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      yieldToSupervisor: true,
    });
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });
});

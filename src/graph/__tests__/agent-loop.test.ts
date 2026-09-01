import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { Overwrite } from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgentFinalizeNode, createAgentPrepareNode, captureAvailabilityFromMessages, captureServicesFromMessages, classifyMeetingMutationToolMessage, createAgentToolsNode, crmWriteDirtiesPrefetch, formatAvailabilityDateOffer, formatAvailabilityTimeOffer, matchAvailabilityDay, meetingMutationClearsAvailability, resolveAvailabilityOffer } from "../agent-loop.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import { OTHER_DATE_LABEL } from "../../shared/clinic-constants.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import {
  formatAvailabilityContext,
  formatBookingMeetingsContext,
  formatContactContext,
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
    const prepare = createAgentPrepareNode();

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
    const prepare = createAgentPrepareNode();
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

  it("passes full thread history into agentMessages", async () => {
    const prepare = createAgentPrepareNode();
    const hoursReply = new AIMessage("hours are 9-18");
    const bookingReply = new AIMessage("what day?");

    const update = await prepare(
      clinicState({
        messages: [
          new HumanMessage("hours?"),
          hoursReply,
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

    const toolsNode = createAgentToolsNode([listTool]);
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

    const toolsNode = createAgentToolsNode([updateTool]);
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

  const bookingAgent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Booking",
    systemPrompt: "STATIC BOOKING PROMPT",
    maxSteps: 10,
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
      agent: bookingAgent,
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
        next: "booking",
      }),
    );

    expect(createCachedGeminiModel).not.toHaveBeenCalled();
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: "gemini-2.5-flash",
        staticSystemInstruction: "STATIC BOOKING PROMPT",
        tools: [sampleTool],
        displayName: "clinic-booking",
      }),
    );
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC BOOKING PROMPT");
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

    await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "booking",
      }),
    );

    expect(createCachedGeminiModel).toHaveBeenCalledOnce();
    expect(bindTools).toHaveBeenCalledTimes(1);
    const messages = cachedInvoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect((messages[0] as HumanMessage).content).toBe("DYNAMIC KYIV");
    expect(messages.some((m) => m instanceof SystemMessage)).toBe(false);
    expect(manager.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "clinic-booking",
        tools: [sampleTool],
      }),
    );
  });

  it("appends contact and listed meetings to booking dynamic context", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
    };

    const node = createAgentLlmNode({
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

    await node(
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

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(bookingDynamic.content).toContain("DYNAMIC KYIV");
    expect(bookingDynamic.content).toContain(formatContactContext(listedContact));
    expect(bookingDynamic.content).toContain(formatBookingMeetingsContext(listedMeetings));
    expect(String(bookingDynamic.content)).toContain("<availability>");
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
    expect(String(bookingDynamic.content)).not.toContain('"visits"');
  });

  it("appends list_services to booking when catalog is set and availability is empty", async () => {
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
        agentMessages: [new HumanMessage("Записатись")],
        servicesContext: sampleServices,
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).toContain("<list_services>");
    expect(String(bookingDynamic.content)).toContain("svc-1");
  });

  it("omits list_services when availabilityContext has days (booking step or mid-booking info question)", async () => {
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

    const availabilityWithDays = {
      days: [{ date: "2026-09-04", slots: [{ label: "11:00", dateStart: "2026-09-04T11:00:00", dateEnd: "2026-09-04T11:30:00" }] }],
      stepMinutes: 30,
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

    for (const humanText of ["4 вересня", "Послуги"]) {
      cachedInvoke.mockClear();
      await bookingNode(
        clinicState({
          agentMessages: [new HumanMessage(humanText)],
          servicesContext: sampleServices,
          availabilityContext: availabilityWithDays,
          next: "booking",
        }),
      );

      const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
      expect(String(bookingDynamic.content)).toContain("<availability>");
      expect(String(bookingDynamic.content)).not.toContain("<list_services>");
    }
  });

  it("omits list_services block when list_services already ran this turn", async () => {
    const manager = {
      getOrCreate: vi.fn(async () => ({
        cacheName: "caches/abc",
        model: "models/gemini-2.5-flash",
      })),
      invalidate: vi.fn(),
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
        next: "booking",
      }),
    );

    const bookingDynamic = (cachedInvoke.mock.calls[0]?.[0] as unknown[])[0] as HumanMessage;
    expect(String(bookingDynamic.content)).not.toContain("<list_services>");
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

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "booking",
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

    const update = await node(
      clinicState({
        agentMessages: [new HumanMessage("hours?")],
        next: "booking",
      }),
    );

    expect(manager.invalidate).toHaveBeenCalledWith("caches/stale");
    expect(manager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(createCachedGeminiModel).toHaveBeenCalledTimes(1);
    const messages = invoke.mock.calls[0]?.[0] as unknown[];
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect((messages[0] as SystemMessage).content).toContain("STATIC BOOKING PROMPT");
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
      replyText: "Підібрати вільний час на консультацію?",
      replyButtons: ["Так", "Обрати іншу процедуру"],
    });
  });

  it("strips an empty reply_buttons trailer and leaves Main Menu only for booking", () => {
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

  it("leaves Main Menu only when last human is Послуги or Записатись and there is no trailer", () => {
    const finalize = createAgentFinalizeNode(agent);

    for (const humanText of ["Послуги", "Записатись"]) {
      const update = finalize(
        clinicState({
          stepCount: 1,
          agentMessages: [
            new HumanMessage(humanText),
            new AIMessage(
              humanText === "Послуги"
                ? "Записати вас на консультацію?"
                : "Підібрати вільний час на консультацію?",
            ),
          ],
        }),
      );

      expect(update.lastHandoff?.replyButtons).toBeUndefined();
    }
  });

  it("leaves Main Menu only for catalog drill-down without a trailer", () => {
    const finalize = createAgentFinalizeNode(agent);
    const update = finalize(
      clinicState({
        stepCount: 1,
        bookingContext: {
          meetings: [{ id: "m-1", visitLabel: "Консультація - завтра о 10:00" }],
        },
        agentMessages: [
          new HumanMessage("Обрати іншу процедуру"),
          new AIMessage(
            "Ось основні напрями послуг нашої клініки 🌿\n• Консультації та діагностика\n• Ін'єкційні процедури\n• Дерматологічні послуги та догляд\n\nЯкий саме напрямок вас цікавить?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("Який саме напрямок");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
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

  it("formatAvailabilityTimeOffer lists all times and caps shortcuts at 3", () => {
    const offer = formatAvailabilityTimeOffer(days[0]!);
    expect(offer.replyText).toContain("14:00");
    expect(offer.replyText).toContain("15:00");
    expect(offer.replyButtons).toEqual(["14:00", "15:00", OTHER_DATE_LABEL]);
  });

  it("matchAvailabilityDay accepts short keyboard labels", () => {
    expect(matchAvailabilityDay("10 вересня", days)?.date).toBe("2026-09-10");
    expect(matchAvailabilityDay(OTHER_DATE_LABEL, days)).toBeNull();
    expect(matchAvailabilityDay("14:00", days)).toBeNull();
  });

  it("resolveAvailabilityOffer prefers tool-turn DATE over checkpoint day pick", () => {
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
    expect(offer?.replyText).toContain("Найближчі вільні дні");
    expect(offer?.replyButtons?.[0]).toBe("10 вересня");
  });
});

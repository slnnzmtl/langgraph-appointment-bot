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
  createAgentFinalizeNode,
  captureAvailabilityFromMessages,
  captureServicesFromMessages,
  classifyContactWriteToolMessage,
  classifyMeetingMutationToolMessage,
  createAgentToolsNode,
  formatAvailabilityDateOffer,
  formatAvailabilityHeading,
  formatAvailabilityTimeOffer,
  matchAvailabilityDay,
  meetingMutationClearsAvailability,
  resolveAvailabilityOffer,
} from "../agent-loop/index.js";
import { resolveBookingCommand } from "../agent-loop/booking-command.js";
import { committedMeetingEntityId } from "../../shared/json-record.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  OTHER_DATE_LABEL,
  OTHER_DATE_LABEL_EN,
} from "../../shared/clinic-constants.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import {
  formatAvailabilityContext,
  formatServicesContext,
} from "../context-blocks.js";

import {
  clinicState,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";


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

  it("classifies contact write outcomes including link and malformed success", () => {
    expect(
      classifyContactWriteToolMessage(
        new ToolMessage({
          content: JSON.stringify({ id: "c-1" }),
          tool_call_id: "1",
          name: "create_contact",
        }),
      ),
    ).toMatchObject({ outcome: "success", tool: "create_contact" });
    expect(
      classifyContactWriteToolMessage(
        new ToolMessage({
          content: JSON.stringify({ success: true }),
          tool_call_id: "2",
          name: "create_contact",
        }),
      ),
    ).toMatchObject({ outcome: "operational", tool: "create_contact" });
    expect(
      classifyContactWriteToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "MCP shut down" }),
          tool_call_id: "3",
          name: "link_telegram_to_contact",
        }),
      ),
    ).toMatchObject({ outcome: "operational", tool: "link_telegram_to_contact" });
    expect(
      classifyContactWriteToolMessage(
        new ToolMessage({
          content: JSON.stringify({
            error: "Name not provided",
            field: "lastName",
          }),
          tool_call_id: "4",
          name: "update_contact",
        }),
      ),
    ).toMatchObject({
      outcome: "known_field",
      tool: "update_contact",
      field: "lastName",
    });
  });

  it("classifies meeting mutation outcomes", async () => {
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
          content: JSON.stringify({ meetingId: "m-only" }),
          tool_call_id: "1",
          name: "reschedule_meeting",
        }),
      ),
    ).toBe("committed");
    expect(committedMeetingEntityId(JSON.stringify({ meetingId: "m-only" }))).toBe("m-only");
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
    // Leftover CRM-shaped error string — not a live emit path; classifies as failed.
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "Note step required" }),
          tool_call_id: "1",
          name: "create_meeting",
        }),
      ),
    ).toBe("failed");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ error: "Not authorized" }),
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
        new ToolMessage({
          content: JSON.stringify({ cancelled: true, left: true }),
          tool_call_id: "1",
          name: "reschedule_meeting",
        }),
      ),
    ).toBe("abandoned");
    expect(
      classifyMeetingMutationToolMessage(
        new ToolMessage({
          content: JSON.stringify({ cancelled: true }),
          tool_call_id: "1",
          name: "reschedule_meeting",
        }),
      ),
    ).toBe("declined");
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

  it("clears availability on committed, failed, or HITL decline", async () => {
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

  it("captures present_availability_slots from tool messages", async () => {
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

  it("formatAvailabilityContext wraps JSON in availability tags", async () => {
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

  it("captures list_services payloads that contain JSON-escaped newlines", async () => {
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

  it("captures list_services from tool messages", async () => {
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

  it("returns undefined for list_services error payloads", async () => {
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

  it("formatServicesContext wraps JSON in list_services tags", async () => {
    const block = formatServicesContext(sampleServices);
    expect(block).toContain("<list_services>");
    expect(block).toContain("svc-1");
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

  it("formatAvailabilityDateOffer lists hours and keeps date-only shortcuts", async () => {
    const offer = formatAvailabilityDateOffer(days);
    expect(offer.replyText).toContain("10 вересня (четвер): 14:00, 15:00");
    expect(offer.replyText).toContain("11 вересня (п'ятниця): 12:00");
    expect(offer.replyButtons).toEqual(["10 вересня", "11 вересня", OTHER_DATE_LABEL]);
  });

  it("uses the canonical search query to describe paginated date pages", async () => {
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

  it("uses the query-aware heading in paginated date offers", async () => {
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

  it("formatAvailabilityTimeOffer lists all times and caps shortcuts at 3", async () => {
    const offer = formatAvailabilityTimeOffer(days[0]!);
    expect(offer.replyText).toContain("14:00");
    expect(offer.replyText).toContain("15:00");
    expect(offer.replyButtons).toEqual(["14:00", "15:00", OTHER_DATE_LABEL]);
  });

  it("matchAvailabilityDay accepts short keyboard labels", async () => {
    expect(matchAvailabilityDay("10 вересня", days)?.date).toBe("2026-09-10");
    expect(matchAvailabilityDay(OTHER_DATE_LABEL, days)).toBeNull();
    expect(matchAvailabilityDay("Інша", days)).toBeNull();
    expect(matchAvailabilityDay(OTHER_DATE_LABEL_EN, days)).toBeNull();
    expect(matchAvailabilityDay("14:00", days)).toBeNull();
  });

  it("resolveAvailabilityOffer prefers day pick TIME over this-turn multi-day DATE", async () => {
    const offer = resolveAvailabilityOffer(
      [
        new HumanMessage("10 вересня"),
        runtimeToolAi([{ id: "1", name: "present_availability_slots", args: {} }]),
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

  it("resolveAvailabilityOffer keeps DATE when human is not a day pick", async () => {
    const offer = resolveAvailabilityOffer(
      [
        new HumanMessage(OTHER_DATE_LABEL),
        runtimeToolAi([{ id: "1", name: "present_availability_slots", args: {} }]),
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


describe("availability draft invariant", () => {
  it("does not coerce present_availability_slots without an accepted service", async () => {
    const { coerceAvailabilityToolCalls } = await import("../agent-loop/tool-call-coercion.js");
    const response = new AIMessage("Підберу найближчі дати.");
    const coerced = coerceAvailabilityToolCalls(
      response,
      clinicState({
        messages: [new HumanMessage("Так")],
        bookingDraft: null,
      }),
      "booking",
      new Set(["present_availability_slots"]),
    );
    expect(coerced.tool_calls ?? []).toEqual([]);
  });

    it("rejects a native present_availability_slots call without an accepted service", async () => {
    const invoked: unknown[] = [];
    const slots = tool(async (input) => {
      invoked.push(input);
      return JSON.stringify({ days: [] });
    }, {
      name: "present_availability_slots",
      description: "availability",
      schema: z.object({
        direction: z.enum(["exact", "earlier", "later", "nearest"]).optional(),
      }),
    });
    // Unstamped legacy call — stripped without a synthetic invariant ToolMessage.
    const update = await createAgentToolsNode([slots], "booking")(
      clinicState({
        bookingDraft: null,
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "slots-1",
            name: "present_availability_slots",
            args: { direction: "nearest" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    const messages = update.agentMessages instanceof Overwrite
      ? update.agentMessages.value
      : update.agentMessages;
    expect((messages as AIMessage[]).some((message) => message instanceof ToolMessage)).toBe(false);
    expect(resolveBookingCommand(clinicState({
      bookingDraft: null,
      messages: [new HumanMessage("Так")],
    })).kind).toBe("continue_llm");
  });

  it("finalize cannot build DATE/TIME UI from a null create draft", async () => {
    const finalize = createAgentFinalizeNode({
      id: "booking",
      name: "Booking",
      description: "Booking",
      systemPrompt: "booking",
      maxSteps: 10,
    });
    const update = await finalize(
      clinicState({
        bookingDraft: null,
        agentMessages: [
          runtimeToolAi([{
              id: "slots-1",
              name: "present_availability_slots",
              args: { direction: "nearest" },
              type: "tool_call",
            }]),
          new ToolMessage({
            content: JSON.stringify({
              days: [{
                date: "2026-10-13",
                dayLabel: "13 жовтня",
                slots: [{
                  id: "slot-13-11",
                  label: "11:00",
                  dateStart: "2026-10-13T11:00:00",
                  dateEnd: "2026-10-13T11:30:00",
                }],
              }],
              stepMinutes: 30,
            }),
            tool_call_id: "slots-1",
            name: "present_availability_slots",
          }),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind === "date_select"
      || unwrapCommandUpdate(update).pendingInteraction?.kind === "time_select").toBeFalsy();
  });
});


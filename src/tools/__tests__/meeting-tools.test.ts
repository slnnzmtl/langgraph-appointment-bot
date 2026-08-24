import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { setTrackEventForTests, type Tier1EventName } from "../../analytics/track.js";
import { clearPendingConfirmsForTests } from "../meeting-confirm.js";
import { createMeetingTools } from "../meeting-tools.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const InterruptState = Annotation.Root({
  result: Annotation<string>,
});

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("create_meeting HITL interrupt", () => {
  const calls: CallRecord[] = [];
  const events: Array<{ name: Tier1EventName; props: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    events.length = 0;
    setTrackEventForTests((name, props) => {
      events.push({ name, props });
    });
  });

  afterEach(() => {
    setTrackEventForTests(null);
    clearPendingConfirmsForTests();
  });

  const completeContact = {
    id: "contact-1",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "+380501112233",
    cTelegram: "tg-42",
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "get_entity") {
      return completeContact;
    }
    if (name === "search_contacts") {
      return { contacts: [completeContact] };
    }
    return { success: true, id: "meeting-1" };
  };

  const buildGraph = (options?: {
    dateStart?: string;
    dateEnd?: string;
    description?: string;
  }) => {
    const [createMeeting] = createMeetingTools({
      callTool,
      assignedUserId: "assigned-99",
    }).filter((tool) => tool.name === "create_meeting");

    if (!createMeeting) {
      throw new Error("create_meeting tool missing");
    }

    return new StateGraph(InterruptState)
      .addNode("book", async () => {
        const result = await createMeeting.invoke({
          name: "Consult",
          dateStart: options?.dateStart ?? "2026-08-07T10:00:00",
          dateEnd: options?.dateEnd ?? "2026-08-07T10:30:00",
          contactId: "contact-1",
          serviceId: "svc-1",
          confirmMessage: "Confirm this booking?",
          ...(options?.description ? { description: options.description } : {}),
        });
        return { result: String(result) };
      })
      .addEdge(START, "book")
      .addEdge("book", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  it("resume confirmed:false skips MCP create_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-cancel" } };

      const first = await graph.invoke({ result: "" }, config);
      expect(first.__interrupt__).toBeDefined();
      expect(calls.map((call) => call.name)).toEqual(["get_entity", "search_entity"]);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: false } }),
        config,
      );
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
      expect(JSON.parse(second.result)).toMatchObject({ cancelled: true });
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "booking_declined",
          props: expect.objectContaining({ action: "create", outcome: "declined" }),
        }),
      );
    });
  });

  it("resume userReply returns awaitingConfirmation without MCP write", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-chat-reply" } };

      await graph.invoke({ result: "" }, config);
      const second = await graph.invoke(
        new Command({ resume: { userReply: "так" } }),
        config,
      );
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
      expect(JSON.parse(second.result)).toMatchObject({
        awaitingConfirmation: true,
        userReply: "так",
        draft: {
          name: "Consult",
          dateStart: "2026-08-07T10:00:00",
          dateEnd: "2026-08-07T10:30:00",
        },
      });
    });
  });

  it("resume confirmed:true calls create_meeting once with required fields", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-confirm" } };

      await graph.invoke({ result: "" }, config);
      expect(calls.map((call) => call.name)).toEqual(["get_entity", "search_entity"]);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: true } }),
        config,
      );
      const createCalls = calls.filter((call) => call.name === "create_meeting");
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]?.args).toMatchObject({
        name: "Consult",
        dateStart: "2026-08-07T10:00:00",
        dateEnd: "2026-08-07T10:30:00",
        parentType: "Contact",
        parentId: "contact-1",
        contactsIds: ["contact-1"],
        cServicesIds: ["svc-1"],
        assignedUserId: "assigned-99",
        status: "Planned",
      });
      expect(JSON.parse(second.result)).toMatchObject({ success: true, id: "meeting-1" });
    });
  });

  it("adds refetch hint when MCP create_meeting fails after confirm", async () => {
    await withTg(async () => {
      const failingCallTool = async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_entity") {
          return completeContact;
        }
        if (name === "search_contacts") {
          return { contacts: [completeContact] };
        }
        if (name === "search_entity") {
          return { list: [] };
        }
        if (name === "create_meeting") {
          throw new Error("Slot already booked");
        }
        return { success: true, id: "meeting-1" };
      };

      const [createMeeting] = createMeetingTools({
        callTool: failingCallTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      if (!createMeeting) {
        throw new Error("create_meeting tool missing");
      }

      const graph = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting.invoke({
            name: "Consult - Ada Lovelace",
            dateStart: "2026-08-07T10:00:00",
            dateEnd: "2026-08-07T10:30:00",
            contactId: "contact-1",
            serviceId: "svc-1",
            confirmMessage: "Confirm?",
          });
          return { result };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const config = { configurable: { thread_id: "hitl-slot-taken" } };
      await graph.invoke({ result: "" }, config);
      const second = await graph.invoke(new Command({ resume: { confirmed: true } }), config);
      const parsed = JSON.parse(second.result) as { error?: string; hint?: string };
      expect(parsed.error).toContain("Slot already booked");
      expect(parsed.hint).toContain("present_availability_slots");
    });
  });

  it("forwards description to MCP create_meeting when provided", async () => {
    await withTg(async () => {
      const graph = buildGraph({
        description: "Пацієнт звернувся щодо бородавок; хоче консультацію.",
      });
      const config = { configurable: { thread_id: "hitl-description" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { confirmed: true } }), config);

      const createCall = calls.find((call) => call.name === "create_meeting");
      expect(createCall?.args).toMatchObject({
        description: "Пацієнт звернувся щодо бородавок; хоче консультацію.",
      });
    });
  });

  it("normalizes space-separated datetimes before MCP create_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph({
        dateStart: "2026-08-07 09:00:00",
        dateEnd: "2026-08-07 09:30:00",
      });
      const config = { configurable: { thread_id: "hitl-normalize-dates" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { confirmed: true } }), config);

      const createCall = calls.find((call) => call.name === "create_meeting");
      expect(createCall?.args).toMatchObject({
        dateStart: "2026-08-07T09:00:00",
        dateEnd: "2026-08-07T09:30:00",
      });
    });
  });

  it("rejects incomplete CRM contact before HITL", async () => {
    await withTg(async () => {
      const incompleteCallTool = async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_entity") {
          return {
            id: "contact-1",
            firstName: "Daniel",
            lastName: null,
            phoneNumber: "+380501234567",
            cTelegram: "tg-42",
          };
        }
        return { success: true, id: "meeting-1" };
      };

      const [createMeeting] = createMeetingTools({
        callTool: incompleteCallTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const graph = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting!.invoke({
            name: "Consult",
            dateStart: "2026-08-07T10:00:00",
            dateEnd: "2026-08-07T10:30:00",
            contactId: "contact-1",
            serviceId: "svc-1",
            confirmMessage: "Confirm this booking?",
          });
          return { result: String(result) };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const first = await graph.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-incomplete" } },
      );
      expect(first.__interrupt__).toBeUndefined();
      expect(calls.map((call) => call.name)).toEqual(["get_entity"]);
      expect(JSON.parse(first.result)).toMatchObject({
        error: "Contact incomplete",
        missingFields: ["lastName"],
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "contact_incomplete_blocked",
          props: expect.objectContaining({
            contact_id: "contact-1",
            missing_fields: ["lastName"],
          }),
        }),
      );
    });
  });

  it("confirmationGiven:true on a first tool call interrupts instead of writing", async () => {
    await withTg(async () => {
      const [createMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const graph = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting!.invoke({
            name: "Consult",
            dateStart: "2026-08-07T10:00:00",
            dateEnd: "2026-08-07T10:30:00",
            contactId: "contact-1",
            serviceId: "svc-1",
            confirmMessage: "Confirm this booking?",
            confirmationGiven: true,
          });
          return { result: String(result) };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const first = await graph.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-first-call-flag" } },
      );
      expect(first.__interrupt__).toBeDefined();
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
    });
  });

  it("confirmationGiven:true after a pending HITL card writes once", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-chat-confirm" } };

      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { userReply: "так" } }), config);

      const [createMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const raw = await createMeeting!.invoke(
        {
          name: "Consult",
          dateStart: "2026-08-07T10:00:00",
          dateEnd: "2026-08-07T10:30:00",
          contactId: "contact-1",
          serviceId: "svc-1",
          confirmMessage: "Confirm this booking?",
          confirmationGiven: true,
        },
        { configurable: { thread_id: "hitl-chat-confirm" } },
      );

      expect(calls.filter((call) => call.name === "create_meeting")).toHaveLength(1);
      expect(JSON.parse(String(raw))).toMatchObject({ success: true, id: "meeting-1" });
    });
  });

  it("confirmationGiven:true with different args does not write", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-mismatch" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { userReply: "так" } }), config);

      const [createMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const graph2 = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting!.invoke({
            name: "Consult",
            dateStart: "2026-08-08T10:00:00",
            dateEnd: "2026-08-08T10:30:00",
            contactId: "contact-1",
            serviceId: "svc-1",
            confirmMessage: "Confirm this booking?",
            confirmationGiven: true,
          });
          return { result: String(result) };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const second = await graph2.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-mismatch" } },
      );
      expect(second.__interrupt__).toBeDefined();
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
    });
  });

  it("rejects a contact that is not linked to this Telegram user", async () => {
    await withTg(async () => {
      const foreignCallTool = async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_entity") {
          return {
            id: "contact-other",
            firstName: "Other",
            lastName: "Patient",
            phoneNumber: "+380501110000",
            cTelegram: "tg-other",
          };
        }
        if (name === "search_contacts") {
          return { contacts: [completeContact] };
        }
        return { success: true, id: "meeting-1" };
      };

      const [createMeeting] = createMeetingTools({
        callTool: foreignCallTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const graph = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting!.invoke({
            name: "Consult",
            dateStart: "2026-08-07T10:00:00",
            dateEnd: "2026-08-07T10:30:00",
            contactId: "contact-other",
            serviceId: "svc-1",
            confirmMessage: "Confirm this booking?",
          });
          return { result: String(result) };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const first = await graph.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-foreign-contact" } },
      );
      expect(first.__interrupt__).toBeUndefined();
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
      expect(JSON.parse(first.result)).toMatchObject({ error: "Not authorized" });
    });
  });

  it("rejects create_meeting when the contact already has a Planned visit", async () => {
    await withTg(async () => {
      const bookedCallTool = async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "get_entity") {
          return completeContact;
        }
        if (name === "search_contacts") {
          return { contacts: [completeContact] };
        }
        if (name === "search_entity") {
          return {
            list: [
              {
                id: "mtg-existing",
                name: "Consult: Ada",
                dateStart: "2026-08-12T10:00:00",
                dateEnd: "2026-08-12T10:30:00",
              },
            ],
          };
        }
        return { success: true, id: "meeting-1" };
      };

      const [createMeeting] = createMeetingTools({
        callTool: bookedCallTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "create_meeting");

      const graph = new StateGraph(InterruptState)
        .addNode("book", async () => {
          const result = await createMeeting!.invoke({
            name: "Consult",
            dateStart: "2026-08-07T10:00:00",
            dateEnd: "2026-08-07T10:30:00",
            contactId: "contact-1",
            serviceId: "svc-1",
            confirmMessage: "Confirm this booking?",
          });
          return { result: String(result) };
        })
        .addEdge(START, "book")
        .addEdge("book", END)
        .compile({ checkpointer: new MemorySaver() });

      const first = await graph.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-already-booked" } },
      );
      expect(first.__interrupt__).toBeUndefined();
      expect(calls.some((call) => call.name === "create_meeting")).toBe(false);
      expect(JSON.parse(first.result)).toMatchObject({
        error: "Already booked",
        meetings: [{ id: "mtg-existing" }],
      });
    });
  });
});

describe("cancel_meeting HITL interrupt", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    clearPendingConfirmsForTests();
  });

  const ownedMeeting = {
    id: "mtg-1",
    name: "Консультація - Артем Тест",
    dateStart: "2026-09-03 11:00:00",
    dateEnd: "2026-09-03 11:30:00",
    parentType: "Contact",
    parentId: "contact-1",
    contactsIds: ["contact-1"],
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "get_entity") {
      if (args.entityType === "Meeting") {
        return ownedMeeting;
      }
      return { id: "contact-1", cTelegram: "tg-42" };
    }
    if (name === "search_contacts") {
      return { contacts: [{ id: "contact-1", cTelegram: "tg-42" }] };
    }
    return { success: true };
  };

  const buildGraph = () => {
    const [cancelMeeting] = createMeetingTools({
      callTool,
      assignedUserId: "assigned-99",
    }).filter((tool) => tool.name === "cancel_meeting");

    if (!cancelMeeting) {
      throw new Error("cancel_meeting tool missing");
    }

    return new StateGraph(InterruptState)
      .addNode("cancel", async () => {
        const result = await cancelMeeting.invoke({
          meetingId: "mtg-1",
          name: "Consult: Ada",
          confirmMessage: "Cancel this appointment?",
        });
        return { result: String(result) };
      })
      .addEdge(START, "cancel")
      .addEdge("cancel", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  it("resume confirmed:false skips MCP update_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-cancel-meeting" } };

      const first = await graph.invoke({ result: "" }, config);
      const interrupt = (first as { __interrupt__?: Array<{ value?: { draft?: Record<string, unknown> } }> })
        .__interrupt__?.[0]?.value?.draft;
      expect(interrupt).toMatchObject({
        confirmMessage: "Cancel this appointment?",
        name: "Consult: Ada",
        dateStart: "2026-09-03T11:00:00",
        dateEnd: "2026-09-03T11:30:00",
      });
      const second = await graph.invoke(
        new Command({ resume: { confirmed: false } }),
        config,
      );
      expect(calls.some((call) => call.name === "update_meeting")).toBe(false);
      expect(JSON.parse(second.result)).toMatchObject({ cancelled: true });
    });
  });

  it("HITL draft fills name and slot from CRM when args omit them", async () => {
    await withTg(async () => {
      const [cancelMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "cancel_meeting");

      const graph = new StateGraph(InterruptState)
        .addNode("cancel", async () => {
          const result = await cancelMeeting!.invoke({
            meetingId: "mtg-1",
            confirmMessage: "Підтвердити скасування візиту?",
          });
          return { result: String(result) };
        })
        .addEdge(START, "cancel")
        .addEdge("cancel", END)
        .compile({ checkpointer: new MemorySaver() });

      const first = await graph.invoke(
        { result: "" },
        { configurable: { thread_id: "hitl-cancel-crm-dates" } },
      );
      const draft = (first as { __interrupt__?: Array<{ value?: { draft?: Record<string, unknown> } }> })
        .__interrupt__?.[0]?.value?.draft;
      expect(draft).toMatchObject({
        confirmMessage: "Підтвердити скасування візиту?",
        name: "Консультація - Артем Тест",
        dateStart: "2026-09-03T11:00:00",
        dateEnd: "2026-09-03T11:30:00",
      });
    });
  });

  it("resume confirmed:true soft-cancels via update_meeting Not Held", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-cancel-confirm" } };

      await graph.invoke({ result: "" }, config);
      const second = await graph.invoke(
        new Command({ resume: { confirmed: true } }),
        config,
      );
      expect(calls.filter((call) => call.name === "update_meeting")).toHaveLength(1);
      const update = calls.find((call) => call.name === "update_meeting");
      expect(update?.args).toEqual({
        meetingId: "mtg-1",
        status: "Not Held",
      });
      expect(JSON.parse(second.result)).toMatchObject({ success: true });
    });
  });

  it("confirmationGiven:true after a pending HITL card calls update_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-cancel-chat" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { userReply: "так" } }), config);

      const [cancelMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "cancel_meeting");

      const raw = await cancelMeeting!.invoke(
        {
          meetingId: "mtg-1",
          name: "Consult: Ada",
          confirmMessage: "Cancel this appointment?",
          confirmationGiven: true,
        },
        { configurable: { thread_id: "hitl-cancel-chat" } },
      );

      expect(calls.filter((call) => call.name === "update_meeting")).toHaveLength(1);
      expect(JSON.parse(String(raw))).toMatchObject({ success: true });
    });
  });
});

describe("reschedule_meeting HITL interrupt", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  afterEach(() => {
    clearPendingConfirmsForTests();
  });

  const ownedMeeting = {
    id: "mtg-1",
    parentType: "Contact",
    parentId: "contact-1",
    contactsIds: ["contact-1"],
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "get_entity") {
      if (args.entityType === "Meeting") {
        return ownedMeeting;
      }
      return { id: "contact-1", cTelegram: "tg-42" };
    }
    if (name === "search_contacts") {
      return { contacts: [{ id: "contact-1", cTelegram: "tg-42" }] };
    }
    return { success: true };
  };

  const buildGraph = () => {
    const [rescheduleMeeting] = createMeetingTools({
      callTool,
      assignedUserId: "assigned-99",
    }).filter((tool) => tool.name === "reschedule_meeting");

    if (!rescheduleMeeting) {
      throw new Error("reschedule_meeting tool missing");
    }

    return new StateGraph(InterruptState)
      .addNode("reschedule", async () => {
        const result = await rescheduleMeeting.invoke({
          meetingId: "mtg-1",
          name: "Consult: Ada",
          dateStart: "2026-08-14 11:00:00",
          dateEnd: "2026-08-14 11:30:00",
          confirmMessage: "Reschedule to this time?",
        });
        return { result: String(result) };
      })
      .addEdge(START, "reschedule")
      .addEdge("reschedule", END)
      .compile({ checkpointer: new MemorySaver() });
  };

  it("resume confirmed:false skips MCP update_meeting", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-reschedule-no" } };

      await graph.invoke({ result: "" }, config);
      const second = await graph.invoke(
        new Command({ resume: { confirmed: false } }),
        config,
      );
      expect(calls.some((call) => call.name === "update_meeting")).toBe(false);
      expect(JSON.parse(second.result)).toMatchObject({ cancelled: true });
    });
  });

  it("resume confirmed:true updates dateStart/dateEnd", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-reschedule-yes" } };

      await graph.invoke({ result: "" }, config);
      const second = await graph.invoke(
        new Command({ resume: { confirmed: true } }),
        config,
      );
      expect(calls.filter((call) => call.name === "update_meeting")).toHaveLength(1);
      const update = calls.find((call) => call.name === "update_meeting");
      expect(update?.args).toEqual({
        meetingId: "mtg-1",
        dateStart: "2026-08-14T11:00:00",
        dateEnd: "2026-08-14T11:30:00",
      });
      expect(JSON.parse(second.result)).toMatchObject({ success: true });
    });
  });

  it("confirmationGiven:true after a pending HITL card updates dates", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-reschedule-chat" } };
      await graph.invoke({ result: "" }, config);
      await graph.invoke(new Command({ resume: { userReply: "так" } }), config);

      const [rescheduleMeeting] = createMeetingTools({
        callTool,
        assignedUserId: "assigned-99",
      }).filter((tool) => tool.name === "reschedule_meeting");

      const raw = await rescheduleMeeting!.invoke(
        {
          meetingId: "mtg-1",
          name: "Consult: Ada",
          dateStart: "2026-08-14 11:00:00",
          dateEnd: "2026-08-14 11:30:00",
          confirmMessage: "Reschedule to this time?",
          confirmationGiven: true,
        },
        { configurable: { thread_id: "hitl-reschedule-chat" } },
      );

      expect(calls.filter((call) => call.name === "update_meeting")).toHaveLength(1);
      expect(JSON.parse(String(raw))).toMatchObject({ success: true });
    });
  });
});

import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, beforeEach } from "vitest";

import { createBookingTools, createReadTools } from "./clinic-tools.js";
import { runWithTelegramUserId } from "./telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const InterruptState = Annotation.Root({
  result: Annotation<string>,
});

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("clinic-tools identity", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "create_contact") {
      return { success: true, id: "contact-1", cTelegram: args.cTelegram };
    }
    if (name === "update_entity") {
      return `Successfully updated Contact record with ID: ${args.entityId as string}`;
    }
    return { ok: true };
  };

  it("create_contact forces cTelegram from holder", async () => {
    await withTg(async () => {
      const [createContact] = createBookingTools({
        callTool,
        assignedUserId: "user-1",
      }).filter((tool) => tool.name === "create_contact");

      expect(createContact).toBeDefined();
      const result = await createContact!.invoke({
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501112233",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        name: "create_contact",
        args: {
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
          cTelegram: "tg-42",
          skipDuplicateCheck: true,
        },
      });
      expect(JSON.parse(result as string)).toMatchObject({ cTelegram: "tg-42" });
    });
  });

  it("link_telegram_to_contact writes holder id via update_entity", async () => {
    await withTg(async () => {
      const [link] = createBookingTools({
        callTool,
        assignedUserId: "user-1",
      }).filter((tool) => tool.name === "link_telegram_to_contact");

      expect(link).toBeDefined();
      await link!.invoke({ contactId: "c-99" });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        name: "update_entity",
        args: {
          entityType: "Contact",
          entityId: "c-99",
          data: { cTelegram: "tg-42" },
        },
      });
    });
  });

  it("find_contact_by_telegram uses holder id", async () => {
    await withTg(async () => {
      const [find] = createBookingTools({
        callTool,
        assignedUserId: "user-1",
      }).filter((tool) => tool.name === "find_contact_by_telegram");

      expect(find).toBeDefined();
      await find!.invoke({});

      expect(calls[0]).toEqual({
        name: "search_contacts",
        args: { cTelegram: "tg-42", limit: 5 },
      });
    });
  });

  it("throws when telegram user id is unset", async () => {
    const [find] = createBookingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((tool) => tool.name === "find_contact_by_telegram");

    const result = await find!.invoke({});
    expect(JSON.parse(result as string)).toMatchObject({
      error: expect.stringContaining("Telegram user id is not set"),
    });
  });

  it("read tools expose list_services and get_service only", () => {
    const names = createReadTools({ callTool }).map((t) => t.name);
    expect(names).toEqual(["list_services", "get_service"]);
  });

  it("booking tools do not include FAQ-only tools", () => {
    const names = createBookingTools({ callTool, assignedUserId: "user-1" }).map((t) => t.name);
    expect(names).not.toContain("list_services");
    expect(names).not.toContain("get_service");
    expect(names).toContain("create_meeting");
    expect(names).toContain("present_availability_slots");
  });

  it("present_availability_slots searches meetings and returns free slots", async () => {
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "search_meetings") {
        return {
          meetings: [
            {
              status: "Planned",
              dateStart: "2026-08-10T09:00:00",
              dateEnd: "2026-08-10T09:30:00",
            },
          ],
        };
      }
      return { ok: true };
    };

    const [tool] = createBookingTools({
      callTool,
      assignedUserId: "user-1",
    }).filter((t) => t.name === "present_availability_slots");

    const raw = await tool!.invoke({ date: "2026-08-10" });
    const parsed = JSON.parse(raw as string) as { slots: Array<{ label: string }> };
    expect(calls[0]).toMatchObject({
      name: "search_meetings",
      args: {
        dateFrom: "2026-08-10",
        dateTo: "2026-08-10",
        assignedUserId: "user-1",
      },
    });
    expect(parsed.slots[0]?.label).not.toBe("09:00");
    expect(parsed.slots.some((s) => s.label === "09:30")).toBe(true);
  });
});

describe("create_meeting HITL interrupt", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
  });

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { success: true, id: "meeting-1" };
  };

  const buildGraph = (dates?: { dateStart: string; dateEnd: string }) => {
    const [createMeeting] = createBookingTools({
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
          dateStart: dates?.dateStart ?? "2026-08-07T10:00:00",
          dateEnd: dates?.dateEnd ?? "2026-08-07T10:30:00",
          contactId: "contact-1",
          serviceId: "svc-1",
          confirmMessage: "Confirm this booking?",
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
      expect(calls).toHaveLength(0);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: false } }),
        config,
      );
      expect(calls).toHaveLength(0);
      expect(JSON.parse(second.result)).toMatchObject({ cancelled: true });
    });
  });

  it("resume confirmed:true calls create_meeting once with required fields", async () => {
    await withTg(async () => {
      const graph = buildGraph();
      const config = { configurable: { thread_id: "hitl-confirm" } };

      await graph.invoke({ result: "" }, config);
      expect(calls).toHaveLength(0);

      const second = await graph.invoke(
        new Command({ resume: { confirmed: true } }),
        config,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.name).toBe("create_meeting");
      expect(calls[0]?.args).toMatchObject({
        name: "Consult",
        dateStart: "2026-08-07T10:00:00",
        dateEnd: "2026-08-07T10:30:00",
        assignedUserId: "assigned-99",
        parentType: "Contact",
        parentId: "contact-1",
        contactsIds: ["contact-1"],
        cServicesIds: ["svc-1"],
        status: "Planned",
      });
      expect(JSON.parse(second.result)).toMatchObject({ success: true, id: "meeting-1" });
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

      expect(calls[0]?.args).toMatchObject({
        dateStart: "2026-08-07T09:00:00",
        dateEnd: "2026-08-07T09:30:00",
      });
    });
  });
});

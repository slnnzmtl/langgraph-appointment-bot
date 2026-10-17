import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createBookingPrepareNode,
  createAgentCommandPrepareNode,
  createAgentToolsNode,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { createContactTools } from "../../tools/contact-tools.js";

import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  makeListedContact,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";

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

    const toolsNode = createAgentToolsNode([updateTool], "faq");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada")],
        agentMessages: [
          runtimeToolAi([
              { id: "1", name: "update_contact", args: { firstName: "Ada" }, type: "tool_call" },
            ]),
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

describe("createAgentToolsNode contact capture (DDD-86)", () => {
  it("sets contactContext from find_contact_by_phone hit", async () => {
    const findTool = tool(
      async () =>
        JSON.stringify({
          contacts: [
            {
              id: "c-phone",
              firstName: "Ada",
              lastName: "Lovelace",
              phoneNumber: "+380682667818",
              cTelegram: null,
            },
          ],
        }),
      {
        name: "find_contact_by_phone",
        description: "Find by phone",
        schema: z.object({ phoneNumber: z.string() }),
      },
    );

    const toolsNode = createAgentToolsNode([findTool], "booking");
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("+380682667818")],
        agentMessages: [
          runtimeToolAi([
              {
                id: "1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380682667818" },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toEqual({
      ownership: "phone",
      contacts: [
        {
          id: "c-phone",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380682667818",
          cTelegram: null,
          missingFields: [],
        },
      ],
    });
    expect(update.prefetchDirty).toBeUndefined();
  });

  it("does not promote a phone match to Telegram ownership", async () => {
    const prepare = createBookingPrepareNode();
    const update = await prepare(
      clinicState({
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            firstName: "Ada",
            cTelegram: null,
          }],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.contactId).toBeNull();
  });

  it("does not prepare a runtime booking command from a phone candidate", async () => {
    const commandPrepare = createAgentCommandPrepareNode();
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "slot-1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
    };
    const update = await commandPrepare(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        availabilityContext: availability,
        agentMessages: [new ToolMessage({
          content: JSON.stringify(availability),
          name: "present_availability_slots",
          tool_call_id: "slots-1",
        })],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
    expect(update.agentMessages).toBeUndefined();
  });

  it("does not trust a draft contact id without Telegram ownership evidence", async () => {
    const availability = {
      days: [{
        date: "2026-09-10",
        slots: [{
          id: "slot-1",
          label: "14:00",
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
        }],
      }],
      stepMinutes: 30,
    };
    const update = await createAgentCommandPrepareNode()(
      clinicState({
        contactContext: null,
        bookingDraft: canonicalBookingDraft({ contactId: "unverified-contact" }),
        availabilityContext: availability,
        agentMessages: [new ToolMessage({
          content: JSON.stringify(availability),
          name: "present_availability_slots",
          tool_call_id: "slots-1",
        })],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toBeUndefined();
    expect(update.agentMessages).toBeUndefined();
  });

  it("strips unstamped create_meeting before ToolNode (ownership is planner/CRM-owned)", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({ contactId: z.string().optional() }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: null,
        bookingDraft: canonicalBookingDraft({ contactId: "unverified-contact" }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-1",
            name: "create_meeting",
            args: { contactId: "unverified-contact" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("marks a successfully linked phone match as Telegram-owned", async () => {
    const linkTool = tool(async () => JSON.stringify({ success: true, id: "c-phone" }), {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([linkTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [runtimeToolAi([{
            id: "link-1",
            name: "link_telegram_to_contact",
            args: { contactId: "c-phone" },
            type: "tool_call",
          }])],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-phone" }],
    });
    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({ contactId: "c-phone" });
  });

  it.each([
    {
      label: "contact outside the phone search",
      contactId: "c-other",
      contacts: [{ id: "c-phone", cTelegram: null }],
    },
    {
      label: "contact linked to another Telegram user",
      contactId: "c-phone",
      contacts: [{ id: "c-phone", cTelegram: "tg-other" }],
    },
  ])("strips unstamped link_telegram_to_contact ($label)", async ({ contactId, contacts }) => {
    const invoke = vi.fn(async () => JSON.stringify({ id: contactId }));
    const linkTool = tool(invoke, {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([linkTool], "booking")(
      clinicState({
        contactContext: { ownership: "phone", contacts },
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "unsafe-link-1",
            name: "link_telegram_to_contact",
            args: { contactId },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("strips unstamped create_contact (occupied checks are contact-command-owned)", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_contact",
      description: "create",
      schema: z.object({
        firstName: z.string(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        messages: [
          new HumanMessage("+380632123123"),
          new HumanMessage("Артем"),
          new HumanMessage("Тест"),
        ],
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-occupied-1",
            name: "create_contact",
            args: {
              firstName: "Артем",
              lastName: "Тест",
              phoneNumber: "+380 63 212 3123",
            },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("still creates a contact when the phone differs from the occupied candidate", async () => {
    const invoke = vi.fn(async () => JSON.stringify({
      success: true,
      id: "c-new",
      firstName: "Артем",
      phoneNumber: "+380502838425",
    }));
    const createTool = tool(invoke, {
      name: "create_contact",
      description: "create",
      schema: z.object({
        firstName: z.string(),
        lastName: z.string().optional(),
        phoneNumber: z.string().optional(),
      }),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        messages: [
          new HumanMessage("+380632123123"),
          new HumanMessage("+380502838425"),
          new HumanMessage("Артем"),
          new HumanMessage("Тест"),
        ],
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({ contactId: null }),
        agentMessages: [runtimeToolAi([{
            id: "create-other-1",
            name: "create_contact",
            args: {
              firstName: "Артем",
              lastName: "Тест",
              phoneNumber: "+380 50 283 8425",
            },
            type: "tool_call",
          }])],
      }),
      { configurable: {} },
    );

    expect(invoke).toHaveBeenCalledOnce();
    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-new" }],
    });
  });

  it("keeps an incomplete linked contact in the model path until details are updated", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "telegram",
        contacts: [{
          id: "c-phone",
          firstName: "Ada",
          lastName: null,
          phoneNumber: "+380501112233",
          missingFields: ["lastName"],
        }],
      },
      bookingDraft: canonicalBookingDraft({ contactId: "c-phone" }),
      availabilityContext: {
        days: [{
          date: "2026-09-10",
          slots: [{
            id: "slot-1",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T14:30:00",
          }],
        }],
        stepMinutes: 30,
      },
    });

    expect(routeAfterAgentPrepare(state, "booking__llm", "booking__command_prepare"))
      .toBe("booking__command_prepare");
  });

  it("updates the checkpointed missing-field projection from the production update response", async () => {
    const updateTool = createContactTools({
      callTool: async (_name, args) =>
        `Successfully updated Contact record with ID: ${String(args?.entityId ?? "")}`,
    }).find((candidate) => candidate.name === "update_contact")!;
    const update = await createAgentToolsNode([updateTool], "booking")(
      clinicState({
        messages: [new HumanMessage("Ada Lovelace")],
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-phone",
            firstName: "Ada",
            lastName: null,
            phoneNumber: "+380501112233",
            missingFields: ["lastName"],
          }],
        },
        agentMessages: [runtimeToolAi([{
            id: "update-1",
            name: "update_contact",
            args: { contactId: "c-phone", lastName: "Lovelace" },
            type: "tool_call",
          }])],
      }),
      { configurable: {} },
    );

    expect(update.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-phone", lastName: "Lovelace", missingFields: [] }],
    });
  });

  it("clears a create command after CRM authorization failure", async () => {
    const createTool = tool(async () => JSON.stringify({ error: "Not authorized" }), {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: "tg-1" }],
        },
        bookingDraft: canonicalBookingDraft({
          contactId: "c-phone",
          phase: "confirming",
          pendingCommand: { action: "create", payload: { contactId: "c-phone" } },
        }),
        availabilityContext: {
          days: [{
            date: "2026-09-10",
            slots: [{
              id: "slot-1",
              label: "14:00",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            }],
          }],
          stepMinutes: 30,
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              days: [{
                date: "2026-09-10",
                slots: [{
                  id: "slot-1",
                  label: "14:00",
                  dateStart: "2026-09-10T14:00:00",
                  dateEnd: "2026-09-10T14:30:00",
                }],
              }],
              stepMinutes: 30,
            }),
            name: "present_availability_slots",
            tool_call_id: "slots-1",
          }),
          runtimeToolAi([{
              id: "create-1",
              name: "create_meeting",
              args: { contactId: "c-phone" },
              type: "tool_call",
            }]),
        ],
      }),
      { configurable: {} },
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      contactId: null,
      pendingCommand: null,
    });
    expect(update.contactContext).toBeNull();
    expect(update.bookingContext).toBeNull();
    expect(update.prefetchDirty).toBe(true);
    expect(routeAfterAgentTools(
      clinicState({ ...clinicState(), ...update }),
        {
          llmName: "llm",
          toolsName: "tools",
          mutationFinalizeName: "mutation-finalize",
          commandPrepareName: "command-prepare",
        })).toBe("mutation-finalize");
  });

  it("strips unstamped create_meeting before linking (ownership is planner-owned)", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
    const update = await createAgentToolsNode([createTool], "booking")(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-phone", firstName: "Ada", cTelegram: null }],
        },
        bookingDraft: canonicalBookingDraft({
          contactId: "c-phone",
          phase: "confirming",
          pendingCommand: { action: "create", payload: { contactId: "c-phone" } },
        }),
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: "create-1",
            name: "create_meeting",
            args: { contactId: "c-phone" },
            type: "tool_call",
          }],
        })],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("does not set contactContext on empty or error find", async () => {
    for (const payload of [
      { contacts: [] },
      { error: "CRM down" },
    ]) {
      const findTool = tool(async () => JSON.stringify(payload), {
        name: "find_contact_by_phone",
        description: "Find by phone",
        schema: z.object({ phoneNumber: z.string() }),
      });

      const toolsNode = createAgentToolsNode([findTool], "booking");
      const update = await toolsNode(
        clinicState({
          messages: [new HumanMessage("+380682667818")],
          contactContext: makeListedContact(),
          agentMessages: [
            runtimeToolAi([
                {
                  id: "1",
                  name: "find_contact_by_phone",
                  args: { phoneNumber: "+380682667818" },
                  type: "tool_call",
                },
              ]),
          ],
        }),
        { configurable: {} },
      );

      expect(update.contactContext).toBeUndefined();
    }
  });
});


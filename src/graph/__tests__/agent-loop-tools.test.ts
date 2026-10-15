import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createAgentCommandPrepareNode,
  createAgentPrepareNode,
  createAgentToolsNode,
  routeAfterAgentPrepare,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { setTrackEventForTests } from "../../analytics/track.js";
import { createContactTools } from "../../tools/contact-tools.js";
import {
  humanProvidedName,
  normalizeNameForMatch,
} from "../agent-loop/protocol.js";
import {
  CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION,
} from "../contact-name-classifier.js";

import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  makeListedContact,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";

/** Ukrainian modifier letter apostrophe (U+02BC). */
const DARYA_MODIFIER = "Дарʼя";
/** Same name with ASCII apostrophe (U+0027). */
const DARYA_ASCII = "Дар'я";

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
    const prepare = createAgentPrepareNode("booking");
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
    const commandPrepare = createAgentCommandPrepareNode("booking");
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
    const update = await createAgentCommandPrepareNode("booking")(
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

  it("blocks a model-supplied contact id when ownership context is missing", async () => {
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
        agentMessages: [runtimeToolAi([{
            id: "create-1",
            name: "create_meeting",
            args: { contactId: "unverified-contact" },
            type: "tool_call",
          }])],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    // Fail-closed strip — no synthetic ownership ToolMessage on the tape.
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
  ])("does not link an unsafe phone candidate: $label", async ({ contactId, contacts }) => {
    const invoke = vi.fn(async () => JSON.stringify({ id: contactId }));
    const linkTool = tool(invoke, {
      name: "link_telegram_to_contact",
      description: "link",
      schema: z.object({ contactId: z.string() }),
    });
    const update = await createAgentToolsNode([linkTool], "booking")(
      clinicState({
        contactContext: { ownership: "phone", contacts },
        agentMessages: [runtimeToolAi([{
            id: "unsafe-link-1",
            name: "link_telegram_to_contact",
            args: { contactId },
            type: "tool_call",
          }])],
      }),
      { configurable: {} },
    );

    expect(invoke).not.toHaveBeenCalled();
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
  });

  it("does not create_contact when phone matches a stored occupied candidate", async () => {
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
        agentMessages: [runtimeToolAi([{
            id: "create-occupied-1",
            name: "create_contact",
            args: {
              firstName: "Артем",
              lastName: "Тест",
              phoneNumber: "+380 63 212 3123",
            },
            type: "tool_call",
          }])],
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
      "llm",
      "tools",
      "mutation-finalize",
      "command-prepare",
    )).toBe("mutation-finalize");
  });

  it("does not call create_meeting for a phone candidate before linking", async () => {
    const invoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(invoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({}),
    });
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
        availabilityContext: availability,
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify(availability),
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

    expect(invoke).not.toHaveBeenCalled();
    // Fail-closed strip: no synthetic ownership ToolMessage; open contact_field instead.
    expect(
      agentMessagesOf(update).some(
        (m) =>
          m instanceof ToolMessage
          && String(m.content).includes("Contact ownership required"),
      ),
    ).toBe(false);
    expect(update.pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "phoneNumber",
    });
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


describe("DDD-87: phone must appear in patient messages", () => {
  afterEach(() => {
    setTrackEventForTests(null);
  });

  const phoneTools = (onInvoke: (name: string, args: Record<string, unknown>) => void) => [
    tool(
      async (args: { phoneNumber: string }) => {
        onInvoke("find_contact_by_phone", args);
        return JSON.stringify({ success: true, total: 0, contacts: [] });
      },
      {
        name: "find_contact_by_phone",
        description: "find",
        schema: z.object({ phoneNumber: z.string() }),
      },
    ),
    tool(
      async (args: { firstName: string; phoneNumber?: string }) => {
        onInvoke("create_contact", args);
        return JSON.stringify({ success: true, id: "c-1" });
      },
      {
        name: "create_contact",
        description: "create",
        schema: z.object({
          firstName: z.string(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: { contactId: string; phoneNumber?: string }) => {
        onInvoke("update_contact", args);
        return JSON.stringify({ success: true });
      },
      {
        name: "update_contact",
        description: "update",
        schema: z.object({
          contactId: z.string(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
  ];

  it.each([
    "find_contact_by_phone",
    "create_contact",
    "update_contact",
  ] as const)("blocks invented phone on %s", async (toolName) => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    const args =
      toolName === "find_contact_by_phone"
        ? { phoneNumber: "+380689999999" }
        : toolName === "create_contact"
          ? { firstName: "Артем", lastName: "Тест", phoneNumber: "+380689999999" }
          : { contactId: "c-1", phoneNumber: "+380689999999" };
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Артем"), new HumanMessage("Тест")],
        agentMessages: [
          runtimeToolAi([{ id: "p1", name: toolName, args, type: "tool_call" }]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
    expect(JSON.parse(String(toolMsg.content))).toEqual({
      error: "Phone not provided",
      field: "phoneNumber",
      hint: "Ask the patient for their clinic phone, then retry with the number they typed.",
    });
    expect(seen).toContainEqual(
      expect.objectContaining({
        name: "tool_error",
        props: expect.objectContaining({
          tool: toolName,
          error_message: "Phone not provided",
        }),
      }),
    );
  });

  it("allows create_contact when human typed local UA and tool passes E.164", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    const update = await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada"), new HumanMessage("0501112233")],
        agentMessages: [
          runtimeToolAi([
              {
                id: "p1",
                name: "create_contact",
                args: {
                  firstName: "Ada",
                  phoneNumber: "+380501112233",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: { firstName: "Ada", phoneNumber: "+380501112233" },
      },
    ]);
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      id: "c-1",
    });
  });

  it("allows create_contact from canonical contactDetails after checkpoint trim", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    const update = await toolsNode(
      clinicState({
        // History trimmed — grounding must use bookingDraft.contactDetails.
        messages: [],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: {
            phoneNumber: "+380501112233",
            firstName: "Олена",
          },
        }),
        agentMessages: [
          runtimeToolAi([
              {
                id: "p1",
                name: "create_contact",
                args: {
                  phoneNumber: "+380501112233",
                  firstName: "Олена",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
        },
      },
    ]);
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content))).toMatchObject({
      id: "c-1",
    });
  });

  it("allows find when human typed spaced local matching tool E.164", async () => {
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("050 111 22 33")],
        agentMessages: [
          runtimeToolAi([
              {
                id: "p1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380501112233" },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual(["find_contact_by_phone"]);
  });

  it("does not treat AI or tool text as patient-provided phone", async () => {
    const invoked: string[] = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name) => {
        invoked.push(name);
      }),
      "booking",
    );
    const update = await toolsNode(
      clinicState({
        messages: [
          new AIMessage("Ваш номер +380501112233?"),
          new ToolMessage({
            content: JSON.stringify({ phoneNumber: "+380501112233" }),
            tool_call_id: "x",
            name: "create_contact",
          }),
          new HumanMessage("Тест"),
        ],
        agentMessages: [
          runtimeToolAi([
              {
                id: "p1",
                name: "find_contact_by_phone",
                args: { phoneNumber: "+380501112233" },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    expect(JSON.parse(String((update.agentMessages as ToolMessage[])[0]!.content)).error).toBe(
      "Phone not provided",
    );
  });

  it("create_contact without phoneNumber still runs", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      phoneTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("Ada")],
        agentMessages: [
          runtimeToolAi([
              {
                id: "p1",
                name: "create_contact",
                args: { firstName: "Ada" },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([{ name: "create_contact", args: { firstName: "Ada" } }]);
  });
});

describe("DDD-59: name must appear in patient messages", () => {
  afterEach(() => {
    setTrackEventForTests(null);
  });

  const nameTools = (onInvoke: (name: string, args: Record<string, unknown>) => void) => [
    tool(
      async (args: { firstName: string; lastName?: string; phoneNumber?: string }) => {
        onInvoke("create_contact", args);
        return JSON.stringify({ success: true, id: "c-1" });
      },
      {
        name: "create_contact",
        description: "create",
        schema: z.object({
          firstName: z.string(),
          lastName: z.string().optional(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: {
        contactId: string;
        firstName?: string;
        lastName?: string;
        phoneNumber?: string;
      }) => {
        onInvoke("update_contact", args);
        return JSON.stringify({ success: true });
      },
      {
        name: "update_contact",
        description: "update",
        schema: z.object({
          contactId: z.string(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phoneNumber: z.string().optional(),
        }),
      },
    ),
  ];

  it.each(["create_contact", "update_contact"] as const)(
    "blocks invented Пацієнт on %s even when phone was typed",
    async (toolName) => {
      const seen: { name: string; props: Record<string, unknown> }[] = [];
      setTrackEventForTests((name, props) => {
        seen.push({ name, props });
      });
      const invoked: string[] = [];
      const toolsNode = createAgentToolsNode(
        nameTools((name) => {
          invoked.push(name);
        }),
        "booking",
      );
      const args =
        toolName === "create_contact"
          ? {
              firstName: "Пацієнт",
              lastName: "Пацієнт",
              phoneNumber: "+380671675272",
            }
          : {
              contactId: "c-1",
              firstName: "Пацієнт",
              lastName: "Пацієнт",
              phoneNumber: "+380671675272",
            };
      const update = await toolsNode(
        clinicState({
          messages: [new HumanMessage("0671675272")],
          agentMessages: [
            runtimeToolAi([{ id: "n1", name: toolName, args, type: "tool_call" }]),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toEqual([]);
      const toolMsg = (update.agentMessages as ToolMessage[])[0]!;
      expect(JSON.parse(String(toolMsg.content))).toEqual({
        error: "Name not provided",
        field: "firstName",
        hint: "Ask the patient for their name, then retry with the value they typed.",
      });
      expect(seen).toContainEqual(
        expect.objectContaining({
          name: "tool_error",
          props: expect.objectContaining({
            tool: toolName,
            error_message: "Name not provided",
          }),
        }),
      );
    },
  );

  it("allows create_contact when human typed first then last name", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      nameTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [
          new HumanMessage("Марія"),
          new HumanMessage("Коваленко"),
          new HumanMessage("0501112233"),
        ],
        agentMessages: [
          runtimeToolAi([
              {
                id: "n1",
                name: "create_contact",
                args: {
                  firstName: "Марія",
                  lastName: "Коваленко",
                  phoneNumber: "+380501112233",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: {
          firstName: "Марія",
          lastName: "Коваленко",
          phoneNumber: "+380501112233",
        },
      },
    ]);
  });

  it("allows update_contact when human typed both names in one line", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      nameTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [new HumanMessage("Марія Коваленко")],
        agentMessages: [
          runtimeToolAi([
              {
                id: "n1",
                name: "update_contact",
                args: {
                  contactId: "c-1",
                  firstName: "Марія",
                  lastName: "Коваленко",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "update_contact",
        args: {
          contactId: "c-1",
          firstName: "Марія",
          lastName: "Коваленко",
        },
      },
    ]);
  });

  it("humanProvidedName matches Дарʼя ↔ Дар'я apostrophe variants (DDD-206)", () => {
    expect(normalizeNameForMatch(DARYA_MODIFIER)).toBe(normalizeNameForMatch(DARYA_ASCII));
    expect(humanProvidedName([new HumanMessage(DARYA_MODIFIER)], DARYA_ASCII)).toBe(true);
    expect(humanProvidedName([new HumanMessage(DARYA_ASCII)], DARYA_MODIFIER)).toBe(true);
  });

  it("classifier instruction documents Дар'я and O'Brien (DDD-206)", () => {
    expect(CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION).toContain("Дар'я");
    expect(CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION).toContain("O'Brien");
  });

  it.skip.each(["create_contact", "update_contact"] as const)(
    "allows %s when collected.firstName apostrophe glyph differs from tool args (DDD-206)",
    async (toolName) => {
      const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
      const toolsNode = createAgentToolsNode(
        nameTools((name, args) => {
          invoked.push({ name, args });
        }),
        "booking",
      );
      const args =
        toolName === "create_contact"
          ? {
              firstName: DARYA_ASCII,
              lastName: "Коваленко",
              phoneNumber: "+380501112233",
            }
          : {
              contactId: "c-1",
              firstName: DARYA_ASCII,
              lastName: "Коваленко",
            };
      await toolsNode(
        clinicState({
          // Human typed a different glyph; grounding comes from collected.
          messages: [new HumanMessage("0501112233")],
          pendingInteraction: {
            kind: "contact_field",
            field: "lastName",
            collected: { firstName: DARYA_MODIFIER, lastName: "Коваленко" },
            choices: [],
          },
          agentMessages: [
            new AIMessage({
              content: "",
              tool_calls: [{ id: "n1", name: toolName, args, type: "tool_call" }],
            }),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toEqual([{ name: toolName, args }]);
      expect(invoked[0]?.args.firstName).toBe(DARYA_ASCII);
    },
  );

  it("forwards create_contact firstName with the original apostrophe glyph (DDD-206)", async () => {
    const invoked: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolsNode = createAgentToolsNode(
      nameTools((name, args) => {
        invoked.push({ name, args });
      }),
      "booking",
    );
    await toolsNode(
      clinicState({
        messages: [
          new HumanMessage(DARYA_MODIFIER),
          new HumanMessage("Коваленко"),
          new HumanMessage("0501112233"),
        ],
        agentMessages: [
          runtimeToolAi([
              {
                id: "n1",
                name: "create_contact",
                args: {
                  firstName: DARYA_MODIFIER,
                  lastName: "Коваленко",
                  phoneNumber: "+380501112233",
                },
                type: "tool_call",
              },
            ]),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([
      {
        name: "create_contact",
        args: {
          firstName: DARYA_MODIFIER,
          lastName: "Коваленко",
          phoneNumber: "+380501112233",
        },
      },
    ]);
    expect(invoked[0]?.args.firstName).toBe(DARYA_MODIFIER);
  });
});

describe("createAgentToolsNode mid-tape ToolNode gate", () => {
  it("runs ToolNode when the last AI with remaining calls is not the last tape message", async () => {
    let invoked = 0;
    const listTool = tool(
      async () => {
        invoked += 1;
        return JSON.stringify({
          list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
          total: 1,
        });
      },
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
          // Trailing ToolMessage leaves the executable AI mid-tape (rewriteAiToolCalls keeps slice after lastAiIndex).
          new ToolMessage({
            content: JSON.stringify({ ok: true }),
            tool_call_id: "stale",
            name: "list_services",
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(invoked).toBe(1);
    expect(update.servicesContext).toEqual({
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    });
  });
});


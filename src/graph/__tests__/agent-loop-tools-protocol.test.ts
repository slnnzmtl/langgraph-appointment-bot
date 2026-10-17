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
} from "vitest";
import { z } from "zod";

import {
  createAgentToolsNode,
} from "../agent-loop/index.js";
import { setTrackEventForTests } from "../../analytics/track.js";
import {
  humanProvidedName,
  normalizeNameForMatch,
} from "../agent-loop/protocol/index.js";
import {
  CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION,
} from "../contact-name-classifier.js";

import {
  agentMessagesOf,
  canonicalBookingDraft,
  clinicState,
  runtimeToolAi,
} from "./agent-loop-fixtures.js";

/** Ukrainian modifier letter apostrophe (U+02BC). */
const DARYA_MODIFIER = "Дарʼя";
/** Same name with ASCII apostrophe (U+0027). */
const DARYA_ASCII = "Дар'я";

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
  ] as const)("strips unstamped %s (phone grounding is planner-owned)", async (toolName) => {
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
          new AIMessage({
            content: "",
            tool_calls: [{ id: "p1", name: toolName, args, type: "tool_call" }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
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

  it("strips unstamped find_contact_by_phone when history has no patient phone", async () => {
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
          new AIMessage({
            content: "",
            tool_calls: [{
              id: "p1",
              name: "find_contact_by_phone",
              args: { phoneNumber: "+380501112233" },
              type: "tool_call",
            }],
          }),
        ],
      }),
      { configurable: {} },
    );
    expect(invoked).toEqual([]);
    expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
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
    "strips unstamped %s (name grounding is planner/CRM-owned)",
    async (toolName) => {
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
            new AIMessage({
              content: "",
              tool_calls: [{ id: "n1", name: toolName, args, type: "tool_call" }],
            }),
          ],
        }),
        { configurable: {} },
      );
      expect(invoked).toEqual([]);
      expect(agentMessagesOf(update).some((m) => m instanceof ToolMessage)).toBe(false);
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

  // DDD-267: removed skipped DDD-206 cases where contact_field stamp gate blocks
  // unstamped writes; glyph equivalence is covered by humanProvidedName above.

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


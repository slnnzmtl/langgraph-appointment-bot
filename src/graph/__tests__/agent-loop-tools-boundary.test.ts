import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, Overwrite } from "@langchain/langgraph";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createAgentToolsNode,
} from "../agent-loop/index.js";
import {
  isToolNodeMessageUpdate,
  toolMessagesFromToolNodeInvoke,
} from "../agent-loop/tool-node-result.js";

import {
  agentMessagesOf,
  clinicState,
  runtimeToolAi,
} from "./agent-loop-fixtures.js";

const expectMatchedToolTape = (update: { agentMessages?: unknown }) => {
  expect(update.agentMessages).toBeInstanceOf(Overwrite);
  const tape = agentMessagesOf(update);
  const lastAiIndex = [...tape]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message instanceof AIMessage)?.index;
  expect(lastAiIndex).toBeDefined();
  const lastAi = tape[lastAiIndex!] as AIMessage;
  const retained = lastAi.tool_calls ?? [];
  const toolMessages = tape.filter((message): message is ToolMessage =>
    message instanceof ToolMessage
  );
  expect(toolMessages).toHaveLength(retained.length);
  expect(new Set(toolMessages.map((message) => message.tool_call_id))).toEqual(
    new Set(retained.map((call) => call.id)),
  );
  return { tape, lastAi, retained, toolMessages };
};

describe("DDD-263/268 ToolNode.invoke result boundary", () => {
  it("recognizes a ToolMessage-only message-update shape", () => {
    const messages = [
      new ToolMessage({ content: "ok", tool_call_id: "1", name: "list_services" }),
    ];
    expect(isToolNodeMessageUpdate({ messages })).toBe(true);
    expect(toolMessagesFromToolNodeInvoke({ messages })).toEqual(messages);
  });

  it("accepts an empty ToolMessage update", () => {
    expect(isToolNodeMessageUpdate({ messages: [] })).toBe(true);
    expect(toolMessagesFromToolNodeInvoke({ messages: [] })).toEqual([]);
  });

  it("rejects missing messages", () => {
    expect(isToolNodeMessageUpdate({})).toBe(false);
    expect(() => toolMessagesFromToolNodeInvoke({})).toThrow(/unsupported result shape/);
  });

  it("rejects LangGraph Command at the boundary", () => {
    const command = new Command({ update: { messages: [] } });
    expect(isToolNodeMessageUpdate(command)).toBe(false);
    expect(() => toolMessagesFromToolNodeInvoke(command)).toThrow(/Command/);
  });

  it("rejects Command arrays", () => {
    const command = new Command({ update: { messages: [] } });
    expect(isToolNodeMessageUpdate([command])).toBe(false);
    expect(() => toolMessagesFromToolNodeInvoke([command])).toThrow(/array result/);
  });

  it("rejects mixed Command / update arrays", () => {
    const mixed = [
      new Command({ update: { messages: [] } }),
      { messages: [] },
    ];
    expect(isToolNodeMessageUpdate(mixed)).toBe(false);
    expect(() => toolMessagesFromToolNodeInvoke(mixed)).toThrow(/array result/);
  });

  it("rejects non-ToolMessage entries in messages", () => {
    const messages = [new AIMessage("ok")];
    expect(isToolNodeMessageUpdate({ messages })).toBe(false);
    expect(() => toolMessagesFromToolNodeInvoke({ messages })).toThrow(/unsupported result shape/);
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

describe("createAgentToolsNode persists filtered tool_calls", () => {
  const listServices = () =>
    tool(
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

  it("executes allowed calls and overwrites mixed unstamped runtime tool_calls", async () => {
    const createInvoke = vi.fn(async () => JSON.stringify({ id: "must-not-run" }));
    const createTool = tool(createInvoke, {
      name: "create_meeting",
      description: "create",
      schema: z.object({ contactId: z.string().optional() }),
    });
    const update = await createAgentToolsNode([listServices(), createTool], "booking")(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "svc-1", name: "list_services", args: {}, type: "tool_call" },
              {
                id: "create-1",
                name: "create_meeting",
                args: { contactId: "unverified" },
                type: "tool_call",
              },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );

    expect(createInvoke).not.toHaveBeenCalled();
    const { lastAi, retained, toolMessages } = expectMatchedToolTape(update);
    expect(retained).toEqual([
      expect.objectContaining({ id: "svc-1", name: "list_services" }),
    ]);
    expect(lastAi.tool_calls?.some((call) => call.name === "create_meeting")).toBe(false);
    expect(toolMessages.map((message) => message.name)).toEqual(["list_services"]);
    expect(update.servicesContext).toEqual({
      list: [{ id: "svc-1", name: "Консультація", duration: 30 }],
      total: 1,
    });
  });

  it("executes allowed calls and overwrites mixed unknown tool_calls", async () => {
    const update = await createAgentToolsNode([listServices()], "booking")(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "svc-1", name: "list_services", args: {}, type: "tool_call" },
              { id: "web-1", name: "search_web", args: {}, type: "tool_call" },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );

    const { lastAi, retained, toolMessages } = expectMatchedToolTape(update);
    expect(retained).toEqual([
      expect.objectContaining({ id: "svc-1", name: "list_services" }),
    ]);
    expect(lastAi.tool_calls?.some((call) => call.name === "search_web")).toBe(false);
    expect(toolMessages.map((message) => message.name)).toEqual(["list_services"]);
  });

  it("overwrites a tape that contains only unknown or disallowed calls", async () => {
    const update = await createAgentToolsNode([listServices()], "booking")(
      clinicState({
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "web-1", name: "search_web", args: {}, type: "tool_call" },
            ],
          }),
        ],
      }),
      { configurable: {} },
    );

    const { lastAi, retained, toolMessages } = expectMatchedToolTape(update);
    expect(lastAi.tool_calls ?? []).toEqual([]);
    expect(retained).toEqual([]);
    expect(toolMessages).toEqual([]);
  });

  it("rejects stamped runtime calls absent from the bound-tool allowlist", async () => {
    // Bound set is informational only; stamped create_meeting must not run.
    const update = await createAgentToolsNode([listServices()], "booking")(
      clinicState({
        agentMessages: [
          runtimeToolAi([{
            id: "create-1",
            name: "create_meeting",
            args: { contactId: "c-1" },
            type: "tool_call",
          }]),
        ],
      }),
      { configurable: {} },
    );

    const { lastAi, retained, toolMessages } = expectMatchedToolTape(update);
    expect(lastAi.tool_calls ?? []).toEqual([]);
    expect(retained).toEqual([]);
    expect(toolMessages).toEqual([]);
  });
});


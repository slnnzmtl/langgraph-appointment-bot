import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const ThreadState = Annotation.Root({
  messages: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => left.concat(right),
    default: () => [],
  }),
  label: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

const compileTiny = (checkpointer: SqliteSaver) =>
  new StateGraph(ThreadState)
    .addNode("echo", async (state) => ({
      messages: [`echo:${state.messages.at(-1) ?? ""}`],
      label: state.label || "set",
    }))
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile({ checkpointer });

describe("SqliteSaver conversation persistence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const tempDb = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "clinic-ckpt-"));
    dirs.push(dir);
    return join(dir, "checkpoints.sqlite");
  };

  it("restores messages and channel state after a new SqliteSaver opens the same file", async () => {
    const dbPath = tempDb();
    const first = SqliteSaver.fromConnString(dbPath);
    const graph = compileTiny(first);
    const threadId = "chat-1";

    await graph.invoke(
      { messages: ["hello"], label: "booking" },
      { configurable: { thread_id: threadId } },
    );

    const second = SqliteSaver.fromConnString(dbPath);
    const restored = compileTiny(second);
    const snap = await restored.getState({ configurable: { thread_id: threadId } });

    expect(snap.values.messages).toEqual(["hello", "echo:hello"]);
    expect(snap.values.label).toBe("booking");
  });

  it("isolates threads on the same database file", async () => {
    const dbPath = tempDb();
    const checkpointer = SqliteSaver.fromConnString(dbPath);
    const graph = compileTiny(checkpointer);

    await graph.invoke(
      { messages: ["a"], label: "one" },
      { configurable: { thread_id: "t-a" } },
    );
    await graph.invoke(
      { messages: ["b"], label: "two" },
      { configurable: { thread_id: "t-b" } },
    );

    const a = await graph.getState({ configurable: { thread_id: "t-a" } });
    const b = await graph.getState({ configurable: { thread_id: "t-b" } });
    expect(a.values.messages).toEqual(["a", "echo:a"]);
    expect(a.values.label).toBe("one");
    expect(b.values.messages).toEqual(["b", "echo:b"]);
    expect(b.values.label).toBe("two");
  });

  it("starts empty for an unknown thread_id", async () => {
    const dbPath = tempDb();
    const graph = compileTiny(SqliteSaver.fromConnString(dbPath));
    const snap = await graph.getState({ configurable: { thread_id: "never-seen" } });
    expect(snap.values.messages ?? []).toEqual([]);
    expect(snap.values.label ?? "").toBe("");
    expect(snap.next).toEqual([]);
  });
});

// 摘要注入段提供（docs/COMPACTION.md §15.2/§15.3）：三态渲染 + tasksOfSnapshot 往返 +
// 真装配两包集成（compact → 摘要节点含任务行 → 变更后二次 compact → 段再生最新）。
// 集成归 todo 侧（依赖方向 todo-tools → compaction——compaction 侧装 todo 是反向）。

import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionId } from "@x-harness/session";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import { createContext, loadPlugins } from "@x-harness/core";
import { llmRuntime } from "@x-harness/llm";
import type { LlmChunk } from "@x-harness/llm";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import { createCompactionPlugin } from "@x-harness/compaction";
import { todoSummarySection } from "../summary.ts";
import { latestTodoSnapshot, tasksOfSnapshot } from "../store.ts";
import { createTodoToolsPlugin } from "../plugin.ts";
import { SECTION_BEGIN } from "@x-harness/compaction";

const snapEvent = (data: unknown): SessionEvent => ({ type: "todo/snapshot", data }) as SessionEvent;

describe("todoSummarySection 三态", () => {
  it("无词条 → undefined（整段缺席——不诱导）", () => {
    expect(todoSummarySection([])).toBeUndefined();
    expect(todoSummarySection([{ type: "user/message", data: {} } as SessionEvent])).toBeUndefined();
  });

  it("空清单 → No tasks（用过且当前空——明确事实）", () => {
    const out = todoSummarySection([snapEvent({ seq: 3, tasks: [], edges: [] })]);
    expect(out).toBe("## Task List\nNo tasks");
  });

  it("行式清单：listText 同构（含依赖注记）", () => {
    const out = todoSummarySection([
      snapEvent({ seq: 1, tasks: [{ id: "1", subject: "A", status: "pending" }], edges: [] }),
      snapEvent({
        seq: 2,
        tasks: [
          { id: "1", subject: "Ship fix", status: "completed", owner: "main" },
          { id: "2", subject: "Add test", status: "in_progress" },
        ],
        edges: [["1", "2"]],
      }),
    ]);
    expect(out).toBe("## Task List\n1. [completed] Ship fix (owner: main; blocks: 2)\n2. [in_progress] Add test (blocked by: 1)");
  });
});

describe("tasksOfSnapshot 往返", () => {
  it("edges 双侧派生恢复（blocks/blockedBy 与桶视角一致）", () => {
    const tasks = tasksOfSnapshot({
      seq: 2,
      tasks: [
        { id: "1", subject: "A", status: "pending" },
        { id: "2", subject: "B", status: "pending" },
      ],
      edges: [["1", "2"]],
    });
    expect(tasks[0]).toMatchObject({ id: "1", blocks: ["2"], blockedBy: [] });
    expect(tasks[1]).toMatchObject({ id: "2", blocks: [], blockedBy: ["1"] });
  });

  it("latestTodoSnapshot 折尾 last-wins", () => {
    const events = [snapEvent({ seq: 1, tasks: [{ id: "1", subject: "old", status: "pending" }], edges: [] }), snapEvent({ seq: 2, tasks: [], edges: [] })];
    expect(latestTodoSnapshot(events)?.seq).toBe(2);
  });
});

describe("真装配两包集成（compaction + todo-tools）", () => {
  function textScript(text: string): AsyncGenerator<LlmChunk> {
    return (async function* (): AsyncGenerator<LlmChunk> {
      yield { type: "text-delta", text };
      yield { type: "finish", finish: { kind: "stop" } };
    })();
  }

  it("compact → 摘要节点含任务行；变更后二次 compact → 段再生为最新", async () => {
    const ctx = createContext();
    const scripts: Array<AsyncGenerator<LlmChunk>> = [];
    await loadPlugins(ctx, [
      sessionPlugin,
      createCompactionPlugin({ contextWindow: 1_000, reserveTokens: 100, keepRecentTokens: 1, summarizer: { model: "fake-model", provider: "fake", contextWindow: 100_000 } } as never),
      toolsPlugin,
      createTodoToolsPlugin(),
    ]);
    const fake = {
      registerAdapter: () => {},
      stream: () => scripts.shift() ?? textScript("## Goal\nintegration"),
    };
    ctx.provide(llmRuntime, fake as never);
    const store = ctx.use(sessionStore);
    const sid = "int-1" as SessionId;
    const made = await store.create({ id: sid });
    if (!made.ok) throw new Error("session failed");
    const s = made.value;
    // 播种足量对话（触达切口）+ 经工具面建任务（append todo/snapshot 落卷）
    for (let i = 0; i < 10; i += 1) {
      s.append("turn/start", { turn: i });
      s.append("step/start", { turn: i, step: 0 });
      s.append("user/message", { turn: i, step: 0, content: [{ type: "text", text: `u${i} ${"x".repeat(120)}` }] }, { surfaceOp: "append" });
      s.append("assistant/message", { turn: i, step: 0, content: [{ type: "text", text: `a${i}` }], usage: { input: 400, output: 60 }, stopReason: "stop" }, { surfaceOp: "append" });
      s.append("step/end", { turn: i, step: 0 });
      s.append("turn/end", { turn: i, reason: { kind: "completed" } });
    }
    const dispatch = ctx.use(toolRegistry);
    const call = (name: string, args: unknown) => dispatch.dispatch({ callId: `c-${name}`, name, args, signal: new AbortController().signal, session: sid });
    await call("task_create", { subject: "Ship integration" });
    await call("task_update", { taskId: "1", status: "in_progress" });
    // 真 compact 流（compaction runner 经软停靠拉取 todo provider）：落账节点含锚点段 + 任务行
    scripts.push(textScript("## Goal\nintegration summary"));
    const runner = ctx.use(await import("@x-harness/compaction").then((m) => m.compactionRunner));
    const result = await runner.compact({ session: sid });
    if (!result.ok) throw new Error(`compact failed: ${result.reason}`);
    const landedNode = s.surface().find((n) => typeof n.event.surfaceOp === "object" && n.event.type === "user/message");
    const landedText = landedNode !== undefined && landedNode.event.type === "user/message" && landedNode.event.data.content[0]?.type === "text" ? landedNode.event.data.content[0].text : "";
    expect(landedText).toContain(SECTION_BEGIN);
    expect(landedText).toContain("## Task List");
    expect(landedText).toContain("1. [in_progress] Ship integration");
    // 变更后二次 compact → 段再生为最新（completed 覆盖 in_progress）；压缩后先续新对话
    // （护栏防「摘要摘摘要」——被摘要区间须含真轮起点）
    for (let i = 10; i < 20; i += 1) {
      s.append("turn/start", { turn: i });
      s.append("step/start", { turn: i, step: 0 });
      s.append("user/message", { turn: i, step: 0, content: [{ type: "text", text: `u${i} ${"x".repeat(120)}` }] }, { surfaceOp: "append" });
      s.append("assistant/message", { turn: i, step: 0, content: [{ type: "text", text: `a${i}` }], usage: { input: 400, output: 60 }, stopReason: "stop" }, { surfaceOp: "append" });
      s.append("step/end", { turn: i, step: 0 });
      s.append("turn/end", { turn: i, reason: { kind: "completed" } });
    }
    await call("task_update", { taskId: "1", status: "completed" });
    scripts.push(textScript("## Goal\nintegration summary v2"));
    const second = await runner.compact({ session: sid });
    if (!second.ok) throw new Error(`compact2 failed: ${second.reason}`);
    // 依赖「压缩区间吞并后投影恒单 replace 节点」语义取最新落账（多 replace 并存是 L2 并装形态——本装置不装 autocompact）
    const landed2 = [...s.surface()].reverse().find((n) => typeof n.event.surfaceOp === "object" && n.event.type === "user/message");
    const text2 = landed2 !== undefined && landed2.event.type === "user/message" && landed2.event.data.content[0]?.type === "text" ? landed2.event.data.content[0].text : "";
    expect(text2).toContain("1. [completed] Ship integration");
    expect(text2).not.toContain("[in_progress]");
    await ctx.dispose();
  });
});

// 工具面单元（docs/TODO.md §1.1/§1.5/§6）：铸文锚、错误词表、无 session 直连（共享清单
// 回归锚）、跨 session 互见、校验层矩阵、并发档声明。

import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";
import { createTodoToolsPlugin } from "../plugin.ts";
import { cardText, listText } from "../tools.ts";
import type { TodoTask } from "../tokens.ts";

/** 完整装配世界（跨包只用公开面——dispatch 经 toolRegistry 服务拿） */
async function makeWorld(): Promise<{ ctx: Context; dispatch: (request: ToolCallRequest) => Promise<ToolOutcome> }> {
  const ctx = createContext();
  await loadPlugins(ctx, [toolsPlugin, createTodoToolsPlugin()]);
  worlds = [...worlds, ctx];
  return { ctx, dispatch: (request) => ctx.use(toolRegistry).dispatch(request) };
}
let worlds: Context[] = [];

afterEach(async () => {
  for (const ctx of worlds) await ctx.dispose();
  worlds = [];
});

let seq = 0;
const call = (name: string, args: unknown) => ({
  callId: `c${(seq += 1)}`,
  name,
  args,
  signal: new AbortController().signal,
});

describe("铸文锚", () => {
  it("task_create 回执：Created task <id>: <subject> (status: pending)", async () => {
    const { dispatch } = await makeWorld();
    const out = await dispatch(call("task_create", { subject: "Fix login bug" }));
    expect(out).toMatchObject({ content: "Created task 1: Fix login bug (status: pending)" });
  });

  it("task_get 卡片：字段缺席省行，在场逐行", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A", description: "d", metadata: { k: 1 } }));
    await dispatch(call("task_create", { subject: "B" }));
    await dispatch(call("task_update", { taskId: "2", addBlockedBy: ["1"], owner: "worker" }));
    const out = await dispatch(call("task_get", { taskId: "2" }));
    expect(out.content).toBe("Task 2: B\nStatus: pending\nOwner: worker\nBlocked by: 1");
    expect(out.isError).toBeUndefined();
  });

  it("task_list：一行一任务 + 三段独立注记；空清单 No tasks", async () => {
    const { dispatch } = await makeWorld();
    expect((await dispatch(call("task_list", {}))).content).toBe("No tasks");
    await dispatch(call("task_create", { subject: "A" }));
    await dispatch(call("task_create", { subject: "B" }));
    await dispatch(call("task_update", { taskId: "1", addBlocks: ["2"], owner: "w" }));
    const out = await dispatch(call("task_list", {}));
    expect(out.content).toBe("1. [pending] A (owner: w; blocks: 2)\n2. [pending] B (blocked by: 1)");
  });

  it("task_update deleted 回执：Deleted task <id>", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A" }));
    const out = await dispatch(call("task_update", { taskId: "1", status: "deleted" }));
    expect(out).toMatchObject({ content: "Deleted task 1" });
  });

  it("update 非删除回执 = 更新后卡片", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A" }));
    const out = await dispatch(call("task_update", { taskId: "1", status: "in_progress", activeForm: "Fixing" }));
    expect(out.content).toBe("Task 1: A\nStatus: in_progress\nActive form: Fixing");
  });

  it("Metadata 铸文对 BigInt 降级 <unserializable>（服务面合法入库值不崩溃）", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A", metadata: { n: 1n } }));
    const out = await dispatch(call("task_get", { taskId: "1" }));
    expect(out.content).toContain("Metadata: <unserializable>");
    expect(out.isError).toBeUndefined();
  });
});

describe("错误词表（分号口径对齐件14）", () => {
  it("not-found:<id>; no such task", async () => {
    const { dispatch } = await makeWorld();
    const out = await dispatch(call("task_get", { taskId: "7" }));
    expect(out).toMatchObject({ content: "not-found:7; no such task", isError: true });
  });

  it("invalid-args：subject / taskId / 依赖引用", async () => {
    const { dispatch } = await makeWorld();
    expect(await dispatch(call("task_create", {}))).toMatchObject({ content: "invalid-args:subject must be a non-empty string", isError: true });
    await dispatch(call("task_create", { subject: "A" }));
    expect(await dispatch(call("task_get", { taskId: "" }))).toMatchObject({ content: "invalid-args:taskId must be a non-empty string", isError: true });
    expect(await dispatch(call("task_update", { taskId: "1", addBlocks: ["5"] }))).toMatchObject({
      content: "invalid-args:addBlocks references unknown task '5'",
      isError: true,
    });
  });

  it("校验层：task_get 缺 taskId 拒；status 非法值拒；metadata 非法形状拒", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A" }));
    const missing = await dispatch(call("task_get", {}));
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("taskId");
    const badStatus = await dispatch(call("task_update", { taskId: "1", status: "done" }));
    expect(badStatus.isError).toBe(true);
    const badMeta = await dispatch(call("task_create", { subject: "A", metadata: "not-an-object" }));
    expect(badMeta.isError).toBe(true);
  });
});

describe("共享清单边界（与件14 task_output 拒无 session 有意相反）", () => {
  it("无 session 直连：四工具全通过（非 agent 调用方可用）", async () => {
    const { dispatch } = await makeWorld();
    await dispatch(call("task_create", { subject: "A" }));
    await dispatch(call("task_update", { taskId: "1", status: "completed" }));
    expect((await dispatch(call("task_get", { taskId: "1" }))).content).toContain("Status: completed");
    expect((await dispatch(call("task_list", {}))).content).toContain("1. [completed] A");
  });

  it("跨 session 互见：A 会话建的清单 B 会话可见可更（协作语义回归锚）", async () => {
    const { dispatch } = await makeWorld();
    const sessionA = { ...call("task_create", { subject: "A" }), session: "sess-a" as never };
    await dispatch(sessionA);
    const sessionB = { ...call("task_update", { taskId: "1", owner: "b", status: "in_progress" }), session: "sess-b" as never };
    const out = await dispatch(sessionB);
    expect(out.content).toContain("Owner: b");
    expect((await dispatch({ ...call("task_list", {}), session: "sess-b" as never })).content).toContain("in_progress");
  });
});

describe("并发档声明", () => {
  it("四工具全 parallel", async () => {
    const { ctx } = await makeWorld();
    const registry = ctx.use(toolRegistry);
    for (const name of ["task_create", "task_get", "task_list", "task_update"]) {
      expect(registry.concurrencyOf(name, {})).toBe("parallel");
    }
  });
});

describe("铸文纯函数直测", () => {
  const task = (over: Partial<TodoTask>): TodoTask => ({
    id: "1",
    subject: "S",
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...over,
  });

  it("cardText 省行与全字段形态", () => {
    expect(cardText(task({}))).toBe("Task 1: S\nStatus: pending");
    expect(cardText(task({ owner: "w", blocks: ["2", "3"], blockedBy: ["4"] }))).toBe(
      "Task 1: S\nStatus: pending\nOwner: w\nBlocks: 2, 3\nBlocked by: 4",
    );
    expect(cardText(task({ description: "d", activeForm: "af" }))).toBe("Task 1: S\nStatus: pending\nDescription: d\nActive form: af");
  });

  it("listText 空态与注记拼接", () => {
    expect(listText([])).toBe("No tasks");
    expect(listText([task({ id: "1", subject: "A", owner: "w" }), task({ id: "2", subject: "B", blockedBy: ["1"] })])).toBe(
      "1. [pending] A (owner: w)\n2. [pending] B (blocked by: 1)",
    );
  });
});

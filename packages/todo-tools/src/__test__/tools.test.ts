// 工具面单元（docs/TODO.md §1.1/§1.5/§6）：铸文锚、错误词表、无 session 直连（共享清单
// 回归锚）、跨 session 互见、校验层矩阵、并发档声明。

import { describe, expect, it, afterEach } from "vitest";
import { createContext, loadPlugins } from "@x-harness/core";
import type { Context } from "@x-harness/core";
import { sessionPlugin, sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { todoList } from "../tokens.ts";
import { toolsPlugin, toolRegistry } from "@x-harness/tools";
import type { ToolCallRequest, ToolOutcome } from "@x-harness/tools";
import { createTodoToolsPlugin } from "../plugin.ts";
import { cardText, listText } from "../tools.ts";
import type { TodoTask } from "../tokens.ts";

/** 完整装配世界（跨包只用公开面——dispatch 经 toolRegistry 服务拿） */
async function makeWorld(): Promise<{ ctx: Context; dispatch: (request: ToolCallRequest) => Promise<ToolOutcome> }> {
  const ctx = createContext();
  await loadPlugins(ctx, [sessionPlugin, toolsPlugin, createTodoToolsPlugin()]);
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

  it("跨 session 隔离：A 会话建的清单 B 会话不可见（每会话一份——修订B 回归锚）", async () => {
    const { ctx, dispatch } = await makeWorld();
    // 带真实会话（会话缺席 fail-closed 是独立用例）——两会话各建各的
    await ctx.use(sessionStore).create({ id: "sess-a" as SessionId });
    await ctx.use(sessionStore).create({ id: "sess-b" as SessionId });
    const sessionA = { ...call("task_create", { subject: "A" }), session: "sess-a" as never };
    const made = await dispatch(sessionA);
    expect(made.content).toContain("Created task 1");
    // B 会话同 id 任务缺席（桶隔离）+ 自建清单 id 各自从 1
    const sessionB = { ...call("task_get", { taskId: "1" }), session: "sess-b" as never };
    const miss = await dispatch(sessionB);
    expect(miss).toMatchObject({ content: "not-found:1; no such task", isError: true });
    const bCreate = await dispatch({ ...call("task_create", { subject: "B-first" }), session: "sess-b" as never });
    expect(bCreate.content).toContain("Created task 1: B-first");
    const aList = await dispatch({ ...call("task_list", {}), session: "sess-a" as never });
    expect(aList.content).toContain("A"); // A 桶不受 B 桶影响
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

describe("事件流持久化（修订B §13.1/§13.4——append/恢复/失败/缺席）", () => {
  it("带 session 变更后卷尾 todo/snapshot = 桶终态；读动词触达不补写快照", async () => {
    const { ctx, dispatch } = await makeWorld();
    const session = await ctx.use(sessionStore).create({ id: "s1" as SessionId });
    if (!session.ok) throw new Error("session create failed");
    await dispatch({ ...call("task_create", { subject: "A" }), session: "s1" as never });
    await dispatch({ ...call("task_update", { taskId: "1", status: "in_progress" }), session: "s1" as never });
    const events = session.value.events();
    const snaps = events.filter((e) => e.type === "todo/snapshot");
    expect(snaps.length).toBe(2); // 两次变更各一条；task_update 的 last-wins
    const lastData = JSON.stringify(snaps.at(-1)?.data);
    expect(lastData).toContain('"status":"in_progress"');
    expect(lastData).toBe(JSON.stringify(ctx.use(todoList).snapshotOf("s1" as never)));
    const before = session.value.events().length;
    await dispatch({ ...call("task_list", {}), session: "s1" as never }); // 读动词不 append
    await dispatch({ ...call("task_get", { taskId: "1" }), session: "s1" as never });
    expect(session.value.events().length).toBe(before);
  });

  it("并发变更（经 dispatch）：卷内快照单调包含，last-wins == 桶终态", async () => {
    const { ctx, dispatch } = await makeWorld();
    const session = await ctx.use(sessionStore).create({ id: "s2" as SessionId });
    if (!session.ok) throw new Error("session create failed");
    const withSession = (name: string, args: unknown) => dispatch({ ...call(name, args), session: "s2" as never });
    await Promise.all([withSession("task_create", { subject: "A" }), withSession("task_create", { subject: "B" })]);
    const snaps = session.value.events().filter((e) => e.type === "todo/snapshot");
    expect(snaps.length).toBe(2);
    const sizes = snaps.map((e) => (e.type === "todo/snapshot" ? e.data.tasks.length : -1)).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 2]); // 单调包含：一条恰含首任务、一条含两任务
    const ids = ctx.use(todoList).list("s2" as never).map((t) => t.id).sort((a, b) => Number(a) - Number(b));
    expect(ids).toEqual(["1", "2"]);
    const lastData = JSON.stringify(snaps.at(-1)?.data);
    expect(lastData).toContain(`"seq":2`);
  });

  it("并发首触达（桶不存在）：两路 dispatch 同 tick——单 fold、无重复任务", async () => {
    const { ctx, dispatch } = await makeWorld();
    const session = await ctx.use(sessionStore).create({ id: "s3" as SessionId });
    if (!session.ok) throw new Error("session create failed");
    // 预置历史卷（resume 形态）：桶不存在，两路并发首次触达
    session.value.append("todo/snapshot", { seq: 1, tasks: [{ id: "1", subject: "A", status: "pending" }], edges: [] });
    const withSession = (name: string, args: unknown) => dispatch({ ...call(name, args), session: "s3" as never });
    const [listed, created] = await Promise.all([withSession("task_list", {}), withSession("task_create", { subject: "B" })]);
    expect(listed.content).toContain("1. [pending] A"); // 惰性恢复看到历史
    expect(created.content).toContain("Created task 2"); // seq 延续
    expect(ctx.use(todoList).list("s3" as never).length).toBe(2);
  });

  it("append 失败自愈：服务面入库 BigInt → 工具变更 isError(applied/not persisted) → 修掉后恢复落账", async () => {
    const { ctx, dispatch } = await makeWorld();
    const session = await ctx.use(sessionStore).create({ id: "s4" as SessionId });
    if (!session.ok) throw new Error("session create failed");
    ctx.use(todoList).create("s4" as never, { subject: "A", metadata: { n: 1n } }); // 服务面：内存真相（恒不 append）
    const fail = await dispatch({ ...call("task_update", { taskId: "1", subject: "A2" }), session: "s4" as never });
    expect(fail.isError).toBe(true);
    expect(fail.content).toContain("applied to the in-memory list but not persisted");
    expect(fail.content).toContain("not-json-safe");
    ctx.use(todoList).update("s4" as never, "1", { metadata: { n: null } }); // 修掉坏值（服务面）
    const healed = await dispatch({ ...call("task_update", { taskId: "1", owner: "w" }), session: "s4" as never });
    expect(healed.isError).toBeUndefined();
    const snaps = session.value.events().filter((e) => e.type === "todo/snapshot");
    expect(snaps.length).toBe(1); // 仅修复后这条成功（此前 append 全拒）
    expect(JSON.stringify(snaps.at(-1)?.data)).not.toContain("1n");
  });

  it("会话缺席 fail-closed：带 session 未建会话 → 四动词统一 isError", async () => {
    const { dispatch } = await makeWorld();
    for (const [name, args] of [["task_create", { subject: "A" }], ["task_list", {}], ["task_get", { taskId: "1" }]] as const) {
      const out = await dispatch({ ...call(name, args as never), session: "ghost" as never });
      expect(out.isError, name).toBe(true);
      expect(out.content, name).toContain("no such session");
    }
  });

  it("dispose 后 dispatch 带 session → isError 而非孤儿桶静默变更", async () => {
    const { ctx, dispatch } = await makeWorld();
    const session = await ctx.use(sessionStore).create({ id: "s5" as SessionId });
    if (!session.ok) throw new Error("session create failed");
    await dispatch({ ...call("task_create", { subject: "A" }), session: "s5" as never });
    ctx.use(sessionStore).dispose("s5" as SessionId);
    const out = await dispatch({ ...call("task_create", { subject: "B" }), session: "s5" as never });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no such session");
  });
});

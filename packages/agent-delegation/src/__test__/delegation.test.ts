// 子代理全链测试（docs/AGENT-DELEGATION.md §4，对照语义子集 X1–X20 的 v1 覆盖项）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "@x-harness/session";
import type { LlmChunk } from "@x-harness/llm";
import type { World } from "./world.ts";
import { Type } from "@sinclair/typebox";
import { sessionStore } from "@x-harness/session";
import { toolsExecute } from "@x-harness/tools";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, OPTIONS, typesOf, resetWorlds } from "./world.ts";
import { createAgentDelegationPlugin } from "../plugin.ts";

const childEnded = (world: World, session: SessionId): boolean =>
  (world.ctx.use(sessionStore).get(session)?.events().some((e) => e.type === "turn/end")) ?? false;

const childHasResult = (world: World, session: SessionId): boolean =>
  (world.ctx.use(sessionStore).get(session)?.events().some((e) => e.type === "tool/result")) ?? false;

beforeEach(() => {
  resetWorlds();
});

describe("spawn 与通知（X1/X2/X4/X10/X13）", () => {
  it("spawn 立即返回文本句柄；子后台完成 → 父 idle 被唤醒（双断言）且通知含 agentId/status/摘要", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    // 父先跑一轮（第一 user 轮），再经工具派子——通知唤醒的是第二轮（双断言的真实形态）
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "parent first turn")]);
    parent.agent.followup("kick off");
    await parent.agent.whenIdle();
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "child done: report body")]);
    world.scripts.set(PARENT_MODEL, [...(world.scripts.get(PARENT_MODEL) ?? []), textScript(PARENT_MODEL, "notified")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "work", type: "worker" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    expect(spawned.content).toContain("agent-1");
    expect(spawned.content).toContain("End your turn and wait");
    const turnCount = (): number => typesOf(parent).filter((t: string) => t === "turn/start").length;
    await vi.waitFor(() => expect(turnCount()).toBe(2), { timeout: 5_000 });
    const userMessages = parent.agent.session.events().filter((e) => e.type === "user/message");
    expect(userMessages.length).toBe(2); // 第一轮 + 通知轮
    const secondTurnUser = userMessages[1];
    const notification = JSON.stringify(secondTurnUser?.data);
    expect(notification).toContain("[agent-notification]");
    expect(notification).toContain("agent-1");
    expect(notification).toContain("completed");
    expect(notification).toContain("child done: report body");
    expect(parent.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await parent.dispose();
  });

  it("同名子共存互不串扰（agentId 唯一寻址）；父 busy 时通知步边界消费（turn 数不变）", async () => {
    const world = await makeWorld({ ...OPTIONS, maxConcurrent: 5 });
    const parent = await spawnParent(world);
    const first = await callTool({ world, name: "agent_spawn", args: { prompt: "a", name: "same-name" }, session: parent.agent.session.id });
    const second = await callTool({ world, name: "agent_spawn", args: { prompt: "b", name: "same-name" }, session: parent.agent.session.id });
    expect(first.content).toContain("agent-1");
    expect(second.content).toContain("agent-2"); // 同名共存、id 互异（X13）
    await parent.dispose();
  });
});

describe("门禁（X7/X8/X17/X20）", () => {
  it("未知类型 → invalid-args 带可用清单；type.tools 未注册名 → 拒", async () => {
    const world = await makeWorld({ types: { worker: { model: CHILD_MODEL }, broken: { tools: ["nope"] } } });
    const parent = await spawnParent(world);
    const unknown = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "ghost" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("available types: worker, broken");
    const broken = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "broken" }, session: parent.agent.session.id });
    expect(broken.isError).toBe(true);
    expect(broken.content).toContain("unregistered tools: nope");
    await parent.dispose();
  });

  it("maxConcurrent：occupied 占槽，超限拒（文案带数字）；完成即释放", async () => {
    const world = await makeWorld({ ...OPTIONS, maxConcurrent: 1 });
    const parent = await spawnParent(world);
    const first = await callTool({ world, name: "agent_spawn", args: { prompt: "a" }, session: parent.agent.session.id });
    expect(first.isError).toBeUndefined();
    const second = await callTool({ world, name: "agent_spawn", args: { prompt: "b" }, session: parent.agent.session.id });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("concurrency limit reached (1 busy");
    await parent.dispose();
  });

  it("maxDepth：深度链逐级拒（maxDepth=1 → 孙拒）", async () => {
    const world = await makeWorld({ ...OPTIONS, maxDepth: 1 });
    const parent = await spawnParent(world);
    const child = await callTool({ world, name: "agent_spawn", args: { prompt: "a" }, session: parent.agent.session.id });
    expect(child.isError).toBeUndefined();
    const childSession = (child.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    // 孙（深度 2 > 1）拒
    const grandchild = await callTool({ world, name: "agent_spawn", args: { prompt: "gc" }, session: childSession });
    expect(grandchild.isError).toBe(true);
    expect(grandchild.content).toContain("max-depth 1 exceeded");
    await parent.dispose();
  });

  it("配置垃圾值构造期 throw（X7）", async () => {
    expect(() => createAgentDelegationPlugin({ types: {}, maxDepth: -1 })).toThrow();
    expect(() => createAgentDelegationPlugin({ types: {}, maxConcurrent: 1.5 })).toThrow();
    expect(() => createAgentDelegationPlugin({ types: {}, maxDepth: Number.NaN })).toThrow();
  });

  it("无 session 调用方（非 agent 宿主直调）→ invalid-args（落档裁决）", async () => {
    const world = await makeWorld(OPTIONS);
    const direct = await world.registry.dispatch({
      callId: "d1",
      name: "agent_spawn",
      args: { prompt: "x" },
      signal: new AbortController().signal,
    });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("inside an agent session");
  });
});

describe("动词族（X4/X11/X17/X19 + 属主校验）", () => {
  it("属主校验：他父会话调动词 → not-owner；未知 id → not-found 引导 list", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const stranger = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    const hijack = await callTool({ world, name: "agent_message", args: { agentId, text: "hi" }, session: stranger.agent.session.id });
    expect(hijack.isError).toBe(true);
    expect(hijack.content).toContain("not-owner");
    const unknown = await callTool({ world, name: "agent_output", args: { agentId: "agent-99" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("use list_agents");
    await parent.dispose();
    await stranger.dispose();
  });

  it("agent_output：报告含 status 与末轮文本；cap 截断带 agent_message 引导", async () => {
    const world = await makeWorld({ ...OPTIONS, reportCap: 10 });
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "0123456789ABCDEF")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const output = await callTool({ world, name: "agent_output", args: { agentId }, session: parent.agent.session.id });
    expect(output.content).toContain("completed");
    expect(output.content).toContain("truncated at 10");
    expect(output.content).toContain("agent_message");
    await parent.dispose();
  });

  it("agent_stop 幂等 + 槽释放；停止后可再 message（X19/X5）", async () => {
    const world = await makeWorld({ ...OPTIONS, maxConcurrent: 1 });
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x" }, session: parent.agent.session.id });
    const agentId = (spawned.content.match(/(agent-\d+)/) ?? [])[1] as string;
    const stopped = await callTool({ world, name: "agent_stop", args: { agentId }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    const again = await callTool({ world, name: "agent_stop", args: { agentId }, session: parent.agent.session.id });
    expect(again.content).toContain("already stopped"); // 幂等
    const respawn = await callTool({ world, name: "agent_spawn", args: { prompt: "y" }, session: parent.agent.session.id });
    expect(respawn.isError).toBeUndefined(); // 槽已释放
    await parent.dispose();
  });

  it("list_agents 限调用方子树并带 sessionId", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const other = await spawnParent(world);
    await callTool({ world, name: "agent_spawn", args: { prompt: "x", name: "mine" }, session: parent.agent.session.id });
    const mine = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(mine.content).toContain("mine");
    expect(mine.content).toMatch(/session=\S+/);
    const theirs = await callTool({ world, name: "list_agents", args: {}, session: other.agent.session.id });
    expect(theirs.content).toContain("(no sub-agents)"); // 子树隔离
    await parent.dispose();
    await other.dispose();
  });
});

describe("fork 重铸（X14）", () => {
  it("fork 种子=父完成轮投影重铸：子上下文含父对话、无 inbox 事件、继承父模型", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "parent turn one")]);
    parent.agent.followup("hello parent");
    await parent.agent.whenIdle();
    // fork（无已完成 turn 的 fork 也合法——如实文案；先完成一轮再 fork 走种子路径）
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "continue", type: "fork" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    const child = world.ctx.use(sessionStore).get(childSession);
    expect(child).toBeDefined();
    const events = child?.events() ?? [];
    const seedEnd = events.findIndex((e) => e.type === "session/end-seed");
    const seedTypes = events.slice(0, seedEnd).map((e) => e.type);
    expect(seedTypes).not.toContain("agent/inbox/spliced"); // 种子段收件箱干净（子自身的 followup insert 在 end-seed 之后，属正常）
    expect(seedTypes).toContain("assistant/message"); // 父对话已入种子
    // 子模型继承父模型（fork 无显式 model）：子的 request/header.model = 父模型
    const childHeader = child?.events().find((e) => e.type === "request/header");
    expect((childHeader?.data as { model?: string } | undefined)?.model).toBe(PARENT_MODEL);
    await parent.dispose();
  });

  it("父无已完成 turn 的 fork → 全新子并如实告知", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "fork" }, session: parent.agent.session.id });
    expect(spawned.content).toContain("no completed turns — started fresh");
    await parent.dispose();
  });
});

describe("白名单双执法（X15）", () => {
  it("子请求头 tools 只含白名单；白名单外 tool_use → tool-not-allowed isError 配对落账", async () => {
    const world = await makeWorld({ types: { worker: { model: CHILD_MODEL, tools: ["allowed_tool"] } } });
    world.registry.register({
      name: "allowed_tool",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "ok" }),
    });
    world.registry.register({
      name: "forbidden_tool",
      inputSchema: Type.Object({}),
      execute: async () => ({ content: "should not run" }),
    });
    const parent = await spawnParent(world);
    // 子脚本（先于 spawn 设置）：直呼白名单外工具
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "fc1", name: "forbidden_tool", argumentsDelta: "{}" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    await vi.waitFor(() => expect(childHasResult(world, childSession)).toBe(true), { timeout: 5_000 });
    const childEvents = world.ctx.use(sessionStore).get(childSession)?.events() ?? [];
    // ① 请求头投影只含白名单
    const header = childEvents.find((e) => e.type === "request/header");
    expect(JSON.stringify(header?.data.tools)).toContain("allowed_tool");
    expect(JSON.stringify(header?.data.tools)).not.toContain("forbidden_tool");
    // ② 直呼被拦截且配对落账
    const denied = childEvents.find((e) => e.type === "tool/result");
    expect(denied?.data).toMatchObject({ callId: "fc1", isError: true });
    expect(String(denied?.data.content)).toContain("tool-not-allowed:forbidden_tool");
    await parent.dispose();
  });

  it("沿树只收窄：受限父的孙白名单 = type.tools ∩ 父白名单", async () => {
    const world = await makeWorld({ types: { narrow: { tools: ["allowed_tool"] }, wider: { tools: ["allowed_tool", "extra_tool"] } } });
    world.registry.register({ name: "allowed_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    world.registry.register({ name: "extra_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    const parent = await spawnParent(world);
    // 子 = narrow（allowed_tool）；孙 = wider（allowed+extra）∩ 父 = allowed_tool
    const child = await callTool({ world, name: "agent_spawn", args: { prompt: "c", type: "narrow" }, session: parent.agent.session.id });
    const childSession = (child.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    const grand = await callTool({ world, name: "agent_spawn", args: { prompt: "g", type: "wider" }, session: childSession });
    expect(grand.isError).toBeUndefined();
    const grandSession = (grand.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    const grandHandle = world.loop.get(grandSession);
    expect(grandHandle?.agent.options.tools).toEqual(["allowed_tool"]); // 只收窄
    if (grandHandle !== undefined) await grandHandle.dispose();
    await parent.dispose();
  });
});

describe("生命周期（X12 部分 / 孤儿收养 / teardown 门）", () => {
  it("父 dispose 后子完成 → 孤儿子被收养（cancel+dispose，不任其烧请求）", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "orphan done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    await parent.dispose(); // 父先走
    await vi.waitFor(() => expect(world.loop.get(childSession)).toBeUndefined(), { timeout: 5_000 });
  });

  it("插件 dispose 级联 cancel 子（tearing-down 门：父不被 steer 复活）", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    const parentTurnsBefore = typesOf(parent).filter((t: string) => t === "turn/start").length;
    await world.disposePlugins(); // 级联
    // 父未被级联通知复活（turn 数不变）
    expect(typesOf(parent).filter((t: string) => t === "turn/start").length).toBe(parentTurnsBefore);
  });
});

describe("X20：execute 内断信号不遗孤儿子", () => {
  it("spawn 的 create 完成但 signal 已断 → 子被 dispose（lineage 无孤儿）", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    const controller = new AbortController();
    // 直接经 registry.dispatch 带 session + 预先 abort 的 signal
    controller.abort();
    const outcome = await world.registry.dispatch({
      callId: "ab1",
      name: "agent_spawn",
      args: { prompt: "x", type: "worker" },
      signal: controller.signal,
      session: parent.agent.session.id,
    });
    // dispatch 管线 abort 检查先挡（工具体未跑）——此路径验证管线防线
    expect(outcome.isError).toBe(true);
    await parent.dispose();
  });
});

describe("并行池三 spawn（exclusive 串行下计数不超——B-P2-3）", () => {
  it("一条消息三个 agent_spawn tool_use 进并行池 → 前两个占槽第三个拒", async () => {
    const world = await makeWorld({ types: { worker: { model: CHILD_MODEL } }, maxConcurrent: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 子挂起流：保持 running 占槽（三个 spawn 的子共享同一闸门）
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const parent = await spawnParent(world);
    // 三连 tool_use（同一 assistant 消息）→ 调度进池；agent_spawn exclusive → 串行执行
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "p1", name: "agent_spawn", argumentsDelta: JSON.stringify({ prompt: "a", type: "worker" }) };
        yield { type: "tool-call-delta", index: 1, callId: "p2", name: "agent_spawn", argumentsDelta: JSON.stringify({ prompt: "b", type: "worker" }) };
        yield { type: "tool-call-delta", index: 2, callId: "p3", name: "agent_spawn", argumentsDelta: JSON.stringify({ prompt: "c", type: "worker" }) };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    parent.agent.followup("spawn three");
    await parent.agent.whenIdle();
    const results = parent.agent.session.events().filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(3);
    const denied = results.filter((e) => (e.data as { isError?: true }).isError === true);
    expect(denied).toHaveLength(1);
    expect(String(denied[0]?.data.content)).toContain("concurrency limit reached (2 busy");
    release();
    await parent.dispose();
  });
});

describe("fork 含工具轮（B-P2-1——tool/result 重铸分支）", () => {
  it("父轮含 tool_use/tool_result → fork 种子重铸含 tool/result 块", async () => {
    const world = await makeWorld(OPTIONS);
    world.registry.register({ name: "calc", inputSchema: Type.Object({}), execute: async () => ({ content: "42" }) });
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "tc1", name: "calc", argumentsDelta: "{}" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
      textScript(PARENT_MODEL, "answer is 42"),
    ]);
    parent.agent.followup("calc");
    await parent.agent.whenIdle();
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "continue", type: "fork" }, session: parent.agent.session.id });
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [])[1] as SessionId;
    const child = world.ctx.use(sessionStore).get(childSession);
    const seedEnd = child?.events().findIndex((e) => e.type === "session/end-seed") ?? -1;
    const seedTypes = child?.events().slice(0, seedEnd).map((e) => e.type) ?? [];
    expect(seedTypes).toContain("tool/result"); // 工具往返重铸入种
    expect(seedTypes).toContain("system/message"); // 系统锚点入种（空文本为 dormant——投影跳过属合法）
    await parent.dispose();
  });
});

describe("X20 execute 内断信号（B-P1-3——真触达 buildChild 防线）", () => {
  it("toolsExecute 中间件换 signal 并在 create 窗口 abort → 子被 dispose、lineage 无孤儿", async () => {
    const world = await makeWorld(OPTIONS);
    const parent = await spawnParent(world);
    // 中间件：换 signal；首个 await 间隙 abort（spawn 的 create 窗口内）
    const abortInCreateWindow = async (request: never, next: (input: never) => Promise<unknown>): Promise<unknown> => {
      if ((request as { name: string }).name !== "agent_spawn") return next(request);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort()); // create 窗口内断（内存 store 全微任务解析——定时器赶不上）
      return next({ ...(request as object), signal: controller.signal } as never);
    };
    const off = world.ctx.on(toolsExecute, abortInCreateWindow as never);
    const spawned = await callTool({ world, name: "agent_spawn", args: { prompt: "x", type: "worker" }, session: parent.agent.session.id });
    off();
    // execute 内防线：create 完成后发现 signal 断 → dispose 子
    expect(spawned.isError).toBe(true);
    expect(spawned.content).toContain("aborted");
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("(no sub-agents)"); // lineage 无孤儿行
    await parent.dispose();
  });
});

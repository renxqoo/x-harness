// 子代理全链测试（docs/AGENT-DELEGATION.md §11.1 迁移矩阵——X1–X20 覆盖项 + 件13 B 阶段新锚）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionId } from "@x-harness/session";
import type { LlmChunk } from "@x-harness/llm";
import { Type } from "@sinclair/typebox";
import { sessionStore } from "@x-harness/session";
import { toolsExecute } from "@x-harness/tools";
import type { World } from "./world.ts";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, typesOf, agentIdOf, sessionOf } from "./world.ts";
import { createAgentDelegationPlugin, validateOptions } from "../plugin.ts";
import { forkSeed } from "../lineage.ts";

const modelOf = (event: { readonly data: unknown } | undefined): string | undefined =>
  event === undefined ? undefined : (event.data as { model?: string }).model;

const eventsOf = (world: World, session: SessionId): readonly ReturnType<Session["events"]>[number][] => {
  const found = world.ctx.use(sessionStore).get(session);
  return found === undefined ? [] : found.events();
};

const childEnded = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "turn/end");

const childHasResult = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "tool/result");

beforeEach(() => {
  resetWorlds();
});

describe("子代理看门狗透传（streamIdleTimeoutMs）", () => {
  it("spawn 的子恒继承父 resolved 看门狗值（症状钉子：删透传字段曾不红）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    // 父显式收紧 33ms——子代理（最常挂死的面）必须继承而非回落缺省
    const tight = await world.loop.create({ agent: { model: PARENT_MODEL, provider: "fake", streamIdleTimeoutMs: 33 } });
    expect(tight.ok).toBe(true);
    if (!tight.ok) return;
    const spawned = await callTool({
      world,
      name: "agent_spawn",
      args: { description: "watchdog probe", prompt: "work", subagent_type: "worker" },
      session: tight.value.agent.session.id,
    });
    expect(spawned.isError).not.toBe(true);
    const child = world.loop.get(sessionOf(spawned.content));
    expect(child).toBeDefined();
    expect(child?.agent.options.streamIdleTimeoutMs).toBe(33); // resolved 值直传
    void parent;
  });

  it("父未显式配置时子回落插件缺省 300_000", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({
      world,
      name: "agent_spawn",
      args: { description: "default probe", prompt: "work", subagent_type: "worker" },
      session: parent.agent.session.id,
    });
    expect(spawned.isError).not.toBe(true);
    const child = world.loop.get(sessionOf(spawned.content));
    expect(child?.agent.options.streamIdleTimeoutMs).toBe(300_000);
  });
});

describe("spawn 与通知（X1/X2/X4/X10/X13）", () => {
  it("spawn 立即返回文本句柄（8hex agentId + type/session）；子后台完成 → 父 idle 被唤醒（双断言）且通知含 agentId/status/摘要", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "parent first turn")]);
    parent.agent.followup("kick off");
    await parent.agent.whenIdle();
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "child done: report body")]);
    world.scripts.set(PARENT_MODEL, [...(world.scripts.get(PARENT_MODEL) ?? []), textScript(PARENT_MODEL, "notified")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "research the thing", prompt: "work", subagent_type: "worker" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    expect(spawned.content).toContain("type 'worker'");
    expect(spawned.content).toContain("stays stable across restarts"); // 修订A：agentId 即持久身份引导
    const turnCount = (): number => typesOf(parent).filter((t: string) => t === "turn/start").length;
    await vi.waitFor(() => expect(turnCount()).toBe(2), { timeout: 5_000 });
    const agentMessages = parent.agent.session.events().filter((e) => e.type === "agent/message");
    expect(agentMessages.length).toBe(1); // 通知（内部消息载体——docs/AGENT-MESSAGE.md §5）；快照与首话仍为 user/message
    expect(parent.agent.session.events().filter((e) => e.type === "user/message" && e.surfaceOp === "append")).toHaveLength(2);
    const notification = JSON.stringify(agentMessages[0]?.data);
    expect(notification).toContain("[agent-notification]");
    expect(notification).toContain(agentId);
    expect(notification).toContain("completed");
    expect(notification).toContain("child done: report body");
    expect(parent.agent.session.events().at(-1)?.data).toMatchObject({ reason: { kind: "completed" } });
    await parent.dispose();
  });

  it("header 三字段锚（件13 接缝 1）：agentName/agentType/agentDepth 随子会话落盘", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "anchor probe", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    const header = world.ctx.use(sessionStore).get(childSession)?.header;
    expect(header?.agentId).toBe(agentIdOf(spawned.content)); // id 持久锚（修订A）
    expect(header?.agentType).toBe("worker");
    expect(header?.agentDepth).toBe(1);
    expect(header?.parentSession).toBe(parent.agent.session.id);
    await parent.dispose();
  });

  it("并行两子：agentId 互异、list 各自成行（修订A——去名后无歧义面）", async () => {
    const world = await makeWorld(await makeOptions({}, { maxConcurrent: 5 }));
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "task a", prompt: "a" }, session: parent.agent.session.id });
    const second = await callTool({ world, name: "agent_spawn", args: { description: "task b", prompt: "b" }, session: parent.agent.session.id });
    const firstId = agentIdOf(first.content);
    const secondId = agentIdOf(second.content);
    expect(firstId).not.toBe(secondId);
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content.split("\n").filter((line) => line.includes("kind=subagent"))).toHaveLength(2);
    await parent.dispose();
  });

  it("model 覆盖序（§7.3）：按次 > 类型定义 > 父模型；fork 忽略 model 参数", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    // ① 按次覆盖类型
    world.scripts.set("override-model", [textScript("override-model", "ok")]);
    const overridden = await callTool({ world, name: "agent_spawn", args: { description: "ov", prompt: "x", subagent_type: "worker", model: "override-model" }, session: parent.agent.session.id });
    const overrideSession = sessionOf(overridden.content);
    await vi.waitFor(() => expect(childEnded(world, overrideSession)).toBe(true), { timeout: 5_000 });
    const overrideHeader = eventsOf(world, overrideSession).find((e) => e.type === "request/header");
    expect(modelOf(overrideHeader)).toBe("override-model");
    // ② 无类型无覆盖 → 父模型
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    parent.agent.followup("warm"); // 父产生末次 header
    await parent.agent.whenIdle();
    const inherited = await callTool({ world, name: "agent_spawn", args: { description: "inh", prompt: "x" }, session: parent.agent.session.id });
    const inheritedSession = sessionOf(inherited.content);
    await vi.waitFor(() => expect(childEnded(world, inheritedSession)).toBe(true), { timeout: 5_000 });
    const inheritedHeader = eventsOf(world, inheritedSession).find((e) => e.type === "request/header");
    expect(modelOf(inheritedHeader)).toBe(PARENT_MODEL);
    // ③ fork 带model 参数 → 忽略，固定父模型
    world.scripts.set(PARENT_MODEL, [...(world.scripts.get(PARENT_MODEL) ?? []), textScript(PARENT_MODEL, "again")]);
    const forked = await callTool({ world, name: "agent_spawn", args: { description: "fk", prompt: "continue", subagent_type: "fork", model: "lies" }, session: parent.agent.session.id });
    const forkSession = sessionOf(forked.content);
    await vi.waitFor(() => expect(childEnded(world, forkSession)).toBe(true), { timeout: 5_000 });
    const forkHeader = eventsOf(world, forkSession).find((e) => e.type === "request/header");
    expect(modelOf(forkHeader)).toBe(PARENT_MODEL);
    await parent.dispose();
  });
});

describe("门禁（X7/X8/X17/X20）", () => {
  it("未知类型 → invalid-args 带可用清单；type.tools 未注册名 → 拒（X17）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL }, broken: { tools: ["nope"] } }));
    const parent = await spawnParent(world);
    const unknown = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "ghost" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("available types: broken, worker");
    const broken = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "broken" }, session: parent.agent.session.id });
    expect(broken.isError).toBe(true);
    expect(broken.content).toContain("unregistered tools: nope");
    await parent.dispose();
  });

  it("maxConcurrent：occupied 占槽，超限拒（文案带数字）（X8）", async () => {
    const world = await makeWorld(await makeOptions({}, { maxConcurrent: 1 }));
    const parent = await spawnParent(world);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "a", prompt: "a" }, session: parent.agent.session.id });
    expect(first.isError).toBeUndefined();
    const second = await callTool({ world, name: "agent_spawn", args: { description: "b", prompt: "b" }, session: parent.agent.session.id });
    expect(second.isError).toBe(true);
    expect(second.content).toContain("concurrency limit reached (1 busy");
    await parent.dispose();
  });

  it("maxDepth：深度链逐级拒（maxDepth=1 → 孙拒）（X7）", async () => {
    const world = await makeWorld(await makeOptions({}, { maxDepth: 1 }));
    const parent = await spawnParent(world);
    const child = await callTool({ world, name: "agent_spawn", args: { description: "c", prompt: "a" }, session: parent.agent.session.id });
    expect(child.isError).toBeUndefined();
    const childSession = sessionOf(child.content);
    const grandchild = await callTool({ world, name: "agent_spawn", args: { description: "g", prompt: "gc" }, session: childSession });
    expect(grandchild.isError).toBe(true);
    expect(grandchild.content).toContain("max-depth 1 exceeded");
    await parent.dispose();
  });

  it("配置垃圾值构造期 throw（X7）", () => {
    expect(() => createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: "/", maxDepth: -1 })).toThrow();
    expect(() => createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: "/", maxConcurrent: 1.5 })).toThrow();
    expect(() => createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: "/", maxDepth: Number.NaN })).toThrow();
    expect(() => createAgentDelegationPlugin({ agentsDirs: [""], workspaceRoot: "/" })).toThrow();
    expect(() => createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: "" } as never)).toThrow();
    expect(() => createAgentDelegationPlugin({ agentsDirs: [], workspaceRoot: "relative/path" } as never)).toThrow();
  });

  it("缺省上限口径：reportCap 34000 / depth 3 / concurrent 10 / resident 32", () => {
    expect(validateOptions({})).toEqual({ maxDepth: 3, maxConcurrent: 10, reportCap: 34_000, maxResident: 32 });
  });

  it("无 session 调用方（非 agent 宿主直调）→ invalid-args（落档裁决）", async () => {
    const world = await makeWorld(await workerOptions());
    const direct = await world.registry.dispatch({
      callId: "d1",
      name: "agent_spawn",
      args: { description: "d", prompt: "x" },
      signal: new AbortController().signal,
    });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("inside an agent session");
  });
});

describe("动词族（X4/X11/X19 + 属主边界重划）", () => {
  it("属主边界（§4.4）：stop 限 owner；message 开放寻址（他父可唤醒）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const stranger = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const hijackStop = await callTool({ world, name: "task_stop", args: { task_id: agentId }, session: stranger.agent.session.id });
    expect(hijackStop.isError).toBe(true);
    expect(hijackStop.content).toContain("not-owner");
    const openMessage = await callTool({ world, name: "agent_message", args: { to: agentId, message: "hi" }, session: stranger.agent.session.id });
    expect(openMessage.isError).toBeUndefined(); // 开放寻址：兄弟/他父可发（§4.4）
    expect(openMessage.content).toContain("Delivered");
    const unknown = await callTool({ world, name: "task_stop", args: { task_id: "agent-ffffffff" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("not-found");
    expect(unknown.content).toContain("no such task in any source"); // 件14 统一词表
    await parent.dispose();
    await stranger.dispose();
  });

  it("报告全文单次交付（X11）：通知携带全文（cap 截断带 agent_message 引导）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { reportCap: 10 }));
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "0123456789ABCDEF")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    void agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const lastNotice = (): string => JSON.stringify(parent.agent.session.events().filter((e) => e.type === "agent/message").at(-1)?.data);
    await vi.waitFor(() => expect(lastNotice()).toContain("truncated at 10"), { timeout: 5_000 }); // 通知：全文经 cap 截断
    expect(lastNotice()).toContain("agent_message");
    await parent.dispose();
  });

  it("task_stop（agent 源）幂等 + 槽释放；停止后可再 message（X19/X5）", async () => {
    const world = await makeWorld(await makeOptions({}, { maxConcurrent: 1 }));
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const stopped = await callTool({ world, name: "task_stop", args: { task_id: agentId }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    const again = await callTool({ world, name: "task_stop", args: { task_id: agentId }, session: parent.agent.session.id });
    expect(again.content).toContain("already stopped"); // 幂等
    const respawn = await callTool({ world, name: "agent_spawn", args: { description: "d2", prompt: "y" }, session: parent.agent.session.id });
    expect(respawn.isError).toBeUndefined(); // 槽已释放
    await parent.dispose();
  });

  it("list_agents 限调用方子树；行格式 kind=subagent agentId session=... status=...", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const other = await spawnParent(world);
    await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const mine = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(mine.content).toContain("kind=subagent");
    expect(mine.content).toMatch(/kind=subagent agent-[0-9a-f]{8} session=\S+/);
    const theirs = await callTool({ world, name: "list_agents", args: {}, session: other.agent.session.id });
    expect(theirs.content).toContain("(no sub-agents)"); // 子树隔离
    await parent.dispose();
    await other.dispose();
  });

});

describe("fork 重铸（X14）", () => {
  it("fork 种子=父完成轮投影重铸：子上下文含父对话、无 inbox 事件、继承父模型", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "parent turn one")]);
    parent.agent.followup("hello parent");
    await parent.agent.whenIdle();
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "continue work", prompt: "continue", subagent_type: "fork" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    const child = world.ctx.use(sessionStore).get(childSession);
    expect(child).toBeDefined();
    const events = child?.events() ?? [];
    const seedEnd = events.findIndex((e) => e.type === "session/end-seed");
    const seedTypes = events.slice(0, seedEnd).map((e) => e.type);
    expect(seedTypes).not.toContain("agent/inbox/spliced");
    expect(seedTypes).toContain("assistant/message");
    const childHeader = child?.events().find((e) => e.type === "request/header");
    expect((childHeader?.data as { model?: string } | undefined)?.model).toBe(PARENT_MODEL);
    await parent.dispose();
  });

  it("fork 种子 agent/message 分流重铸：content（兄弟报告事实）继承、directive 丢弃", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const session = parent.agent.session;
    session.append("user/message", { turn: 0, step: 0, content: [{ type: "text", text: "q" }] }, { surfaceOp: "append" });
    session.append("turn/start", { turn: 0 });
    session.append("agent/message", { turn: 0, step: 0, source: "delegation-report", kind: "content", content: [{ type: "text", text: "sibling report fact" }] }, { surfaceOp: "append" });
    session.append("agent/message", { turn: 0, step: 0, source: "output-continuation", kind: "directive", content: [{ type: "text", text: "Output token limit hit..." }] }, { surfaceOp: "append" });
    session.append("assistant/message", { turn: 0, step: 0, content: [{ type: "text", text: "a" }], stopReason: "stop" }, { surfaceOp: "append" });
    session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
    const seed = forkSeed(session);
    const recast = seed.filter((e) => e.type === "agent/message");
    expect(recast).toHaveLength(1); // content 继承、directive 丢弃（docs/AGENT-MESSAGE.md §5）
    expect(recast[0]?.data).toMatchObject({ source: "delegation-report", kind: "content", content: [{ type: "text", text: "sibling report fact" }] });
    await parent.dispose();
  });

  it("父无已完成 turn 的 fork → 全新子并如实告知", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "fork" }, session: parent.agent.session.id });
    expect(spawned.content).toContain("no completed turns — started fresh");
    await parent.dispose();
  });

  it("fork 含工具轮：tool/result 重铸分支", async () => {
    const world = await makeWorld(await workerOptions());
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
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "continue", subagent_type: "fork" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    const child = world.ctx.use(sessionStore).get(childSession);
    const seedEnd = child?.events().findIndex((e) => e.type === "session/end-seed") ?? -1;
    const seedTypes = child?.events().slice(0, seedEnd).map((e) => e.type) ?? [];
    expect(seedTypes).toContain("tool/result");
    expect(seedTypes).toContain("system/message");
    await parent.dispose();
  });
});

describe("白名单双执法（X15）", () => {
  it("子请求头 tools 只含白名单；白名单外 tool_use → tool-not-allowed isError 配对落账", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL, tools: ["allowed_tool"] } }));
    world.registry.register({ name: "allowed_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    world.registry.register({ name: "forbidden_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "should not run" }) });
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "fc1", name: "forbidden_tool", argumentsDelta: "{}" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childHasResult(world, childSession)).toBe(true), { timeout: 5_000 });
    const childEvents = world.ctx.use(sessionStore).get(childSession)?.events() ?? [];
    const header = childEvents.find((e) => e.type === "request/header");
    expect(JSON.stringify(header?.data.tools)).toContain("allowed_tool");
    expect(JSON.stringify(header?.data.tools)).not.toContain("forbidden_tool");
    const denied = childEvents.find((e) => e.type === "tool/result");
    expect(denied?.data).toMatchObject({ callId: "fc1", isError: true });
    expect(String(denied?.data.content)).toContain("tool-not-allowed:forbidden_tool");
    await parent.dispose();
  });

  it("沿树只收窄：受限父的孙白名单 = type.tools ∩ 父白名单", async () => {
    const world = await makeWorld(await makeOptions({ narrow: { tools: ["allowed_tool"] }, wider: { tools: ["allowed_tool", "extra_tool"] } }));
    world.registry.register({ name: "allowed_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    world.registry.register({ name: "extra_tool", inputSchema: Type.Object({}), execute: async () => ({ content: "ok" }) });
    const parent = await spawnParent(world);
    const child = await callTool({ world, name: "agent_spawn", args: { description: "c", prompt: "c", subagent_type: "narrow" }, session: parent.agent.session.id });
    const childSession = sessionOf(child.content);
    const grand = await callTool({ world, name: "agent_spawn", args: { description: "g", prompt: "g", subagent_type: "wider" }, session: childSession });
    expect(grand.isError).toBeUndefined();
    const grandSession = sessionOf(grand.content);
    const grandHandle = world.loop.get(grandSession);
    expect(world.registry.restrictionOf(grandSession)).toEqual(["allowed_tool"]); // 只收窄（W2A：唯一真相在 registry 会话层）
    if (grandHandle !== undefined) await grandHandle.dispose();
    await parent.dispose();
  });
});

describe("生命周期（孤儿收养 / teardown 门 / 唤醒重验）", () => {
  it("父 dispose 后子完成 → 孤儿子被收养（cancel+dispose，不任其烧请求）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "orphan done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const childSession = sessionOf(spawned.content);
    await parent.dispose();
    await vi.waitFor(() => expect(world.loop.get(childSession)).toBeUndefined(), { timeout: 5_000 });
  });

  it("message 唤醒入口重验父存活（§4.1-④）：父已死的子 message → 收养 + not-found", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const stranger = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await parent.dispose(); // 父先走
    const refused = await callTool({ world, name: "agent_message", args: { to: agentId, message: "wake" }, session: stranger.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("not-found");
    await vi.waitFor(() => expect(world.loop.get(childSession)).toBeUndefined(), { timeout: 5_000 }); // 收养收敛
    await stranger.dispose();
  });

  it("插件 dispose 级联 cancel 子（tearing-down 门：父不被 steer 复活）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const before = typesOf(parent).filter((t: string) => t === "turn/start").length;
    await world.disposePlugins();
    expect(typesOf(parent).filter((t: string) => t === "turn/start").length).toBe(before);
  });
});

describe("X20：execute 内断信号不遗孤儿子", () => {
  it("spawn 的 create 完成但 signal 已断 → 子被 dispose（lineage 无孤儿）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const controller = new AbortController();
    controller.abort();
    const outcome = await world.registry.dispatch({
      callId: "ab1",
      name: "agent_spawn",
      args: { description: "d", prompt: "x", subagent_type: "worker" },
      signal: controller.signal,
      session: parent.agent.session.id,
    });
    expect(outcome.isError).toBe(true); // dispatch 管线 abort 检查先挡（工具体未跑）
    await parent.dispose();
  });

  it("toolsExecute 中间件换 signal 并在 create 窗口 abort → 子被 dispose、lineage 无孤儿（真触达防线）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const abortInCreateWindow = async (request: never, next: (input: never) => Promise<unknown>): Promise<unknown> => {
      if ((request as { name: string }).name !== "agent_spawn") return next(request);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort());
      return next({ ...(request as object), signal: controller.signal } as never);
    };
    const off = world.ctx.on(toolsExecute, abortInCreateWindow as never);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    off();
    expect(spawned.isError).toBe(true);
    expect(spawned.content).toContain("aborted");
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("(no sub-agents)");
    await parent.dispose();
  });
});

describe("并行池三 spawn（exclusive 串行下计数不超）", () => {
  it("一条消息三个 agent_spawn tool_use 进并行池 → 前两个占槽第三个拒", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 2 }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    world.scripts.set(PARENT_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "p1", name: "agent_spawn", argumentsDelta: JSON.stringify({ description: "a", prompt: "a", subagent_type: "worker" }) };
        yield { type: "tool-call-delta", index: 1, callId: "p2", name: "agent_spawn", argumentsDelta: JSON.stringify({ description: "b", prompt: "b", subagent_type: "worker" }) };
        yield { type: "tool-call-delta", index: 2, callId: "p3", name: "agent_spawn", argumentsDelta: JSON.stringify({ description: "c", prompt: "c", subagent_type: "worker" }) };
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

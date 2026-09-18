// 寻址终态测试（docs/AGENT-DELEGATION.md §5.2/§11.2）：裸名 latest-wins、[ref] 消歧、
// main 通道（子→父信封/根拒）、task_id 按名、block/timeout 等待语义。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "@x-harness/session";
import type { LlmChunk } from "@x-harness/llm";
import type { AgentHandle } from "@x-harness/agent-loop";
import { sessionStore } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, typesOf, agentIdOf, sessionOf } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const userTextsOf = (world: World, session: SessionId): string =>
  world.ctx
    .use(sessionStore)
    .get(session)
    ?.events()
    .filter((e) => e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";

const turnStartsOf = (parent: AgentHandle): number => typesOf(parent).filter((t: string) => t === "turn/start").length;

const turnEndsOf = (world: World, session: SessionId): number =>
  world.ctx.use(sessionStore).get(session)?.events().filter((e) => e.type === "turn/end").length ?? 0;

describe("裸名寻址（§5.2-4 latest-wins + [ref] 消歧）", () => {
  it("同名两子：裸名唤醒最新者、name [ref] 唤醒旧者（收件内容按子会话对账）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const texts = ["a1", "a2", "a3", "a4"];
    world.scripts.set(CHILD_MODEL, texts.map((t) => textScript(CHILD_MODEL, t)));
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p1"), textScript(PARENT_MODEL, "p2"), textScript(PARENT_MODEL, "p3"), textScript(PARENT_MODEL, "p4")]);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker", name: "twin" }, session: parent.agent.session.id });
    const second = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "b", subagent_type: "worker", name: "twin" }, session: parent.agent.session.id });
    const firstSession = sessionOf(first.content);
    const secondSession = sessionOf(second.content);
    const firstRef = agentIdOf(first.content).slice(-6);
    await vi.waitFor(() => expect(turnEndsOf(world, firstSession) + turnEndsOf(world, secondSession)).toBe(2), { timeout: 5_000 });

    const bare = await callTool({ world, name: "agent_message", args: { to: "twin", message: "wake latest" }, session: parent.agent.session.id });
    expect(bare.isError).toBeUndefined();
    const precise = await callTool({ world, name: "agent_message", args: { to: `twin [${firstRef}]`, message: "wake oldest" }, session: parent.agent.session.id });
    expect(precise.isError).toBeUndefined();

    await vi.waitFor(() => expect(turnEndsOf(world, firstSession)).toBe(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(turnEndsOf(world, secondSession)).toBe(2), { timeout: 5_000 });
    // 身份对账：各子的收件箱含各自的唤醒消息（steer 落 user/message）
    expect(userTextsOf(world, secondSession)).toContain("wake latest"); // 裸名 → 最新者
    expect(userTextsOf(world, firstSession)).toContain("wake oldest"); // [ref] → 旧者
    expect(userTextsOf(world, firstSession)).not.toContain("wake latest");
    await parent.dispose();
  });

  it("未知裸名/错 [ref] → not-found（[ref] 带可用清单）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", name: "only" }, session: parent.agent.session.id });
    const ref = agentIdOf(spawned.content).slice(-6);
    const unknown = await callTool({ world, name: "agent_message", args: { to: "ghost", message: "hi" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("not-found:ghost");
    const wrongRef = await callTool({ world, name: "agent_message", args: { to: "only [ffffff]", message: "hi" }, session: parent.agent.session.id });
    expect(wrongRef.isError).toBe(true);
    expect(wrongRef.content).toContain(`[${ref}]`);
    await parent.dispose();
  });
});

describe("main 通道（§5.1/§5.2-1）", () => {
  it("子代理 agent_message{to:'main'} → 父会话收 <cross-session-message from=子名>", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "ack"), textScript(PARENT_MODEL, "parent consumed child message")]);
    // 子脚本：第二轮向 main 发消息
    world.scripts.set(CHILD_MODEL, [
      textScript(CHILD_MODEL, "child done"),
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "m1", name: "agent_message", argumentsDelta: JSON.stringify({ to: "main", message: "child asking parent" }) };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "work", subagent_type: "worker", name: "reporter" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(turnEndsOf(world, childSession)).toBe(1), { timeout: 5_000 });
    // 通知唤醒父（turn 1）；message 唤醒子（turn 2 → 发 main → 父 turn 2）
    const agentId = agentIdOf(spawned.content);
    const woke = await callTool({ world, name: "agent_message", args: { to: agentId, message: "report to main" }, session: parent.agent.session.id });
    expect(woke.isError).toBeUndefined();
    await vi.waitFor(() => {
      // userTextsOf 是 JSON.stringify 空间——内层引号被转义，按转义形态断言
      expect(userTextsOf(world, parent.agent.session.id)).toContain('<cross-session-message from=\\"reporter\\">child asking parent</cross-session-message>');
    }, { timeout: 5_000 });
    await vi.waitFor(() => expect(turnStartsOf(parent)).toBeGreaterThanOrEqual(2), { timeout: 5_000 }); // 子工具轮完成还会再通知父——计数只增
    await parent.dispose();
  });

  it("根会话调 main → invalid-args（仅后台子代理可用）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const refused = await callTool({ world, name: "agent_message", args: { to: "main", message: "hi" }, session: parent.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("only available to background sub-agents");
    await parent.dispose();
  });
});

describe("task_id 按名（output/stop）与 block/timeout", () => {
  it("output/stop 按裸名与 [ref] 生效（owner 限定）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 5 }));
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one"), textScript(CHILD_MODEL, "two")]);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker", name: "pair" }, session: parent.agent.session.id });
    const second = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "b", subagent_type: "worker", name: "pair" }, session: parent.agent.session.id });
    const firstRef = agentIdOf(first.content).slice(-6);
    const stopBare = await callTool({ world, name: "agent_stop", args: { task_id: "pair" }, session: parent.agent.session.id });
    expect(stopBare.isError).toBeUndefined();
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    const stoppedLine = listed.content.split("\n").find((line) => line.includes("status=stopped"));
    expect(stoppedLine ?? "").toContain(agentIdOf(second.content)); // 裸名停的是最新者
    const outputRef = await callTool({ world, name: "agent_output", args: { task_id: `pair [${firstRef}]`, block: false }, session: parent.agent.session.id });
    expect(outputRef.isError).toBeUndefined();
    expect(outputRef.content).toContain(agentIdOf(first.content)); // [ref] 读的是旧者
    await parent.dispose();
  });

  it("block/timeout：在飞子 block=true 超时 → running 快照；完成后 block → 报告", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }));
    const parent = await spawnParent(world);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<LlmChunk> {
        await gate;
        yield { type: "text-delta", text: "slow child finished" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    await vi.waitFor(async () => {
      const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
      expect(listed.content).toContain("status=running");
    }, { timeout: 5_000 });
    const waited = await callTool({ world, name: "agent_output", args: { task_id: agentId, block: true, timeout: 50 }, session: parent.agent.session.id });
    expect(waited.isError).toBeUndefined();
    expect(waited.content).toContain("still running");
    expect(waited.content).toContain("waited 50ms");
    release();
    const done = await callTool({ world, name: "agent_output", args: { task_id: agentId, block: true, timeout: 5_000 }, session: parent.agent.session.id });
    expect(done.content).toContain("completed");
    expect(done.content).toContain("slow child finished");
    await parent.dispose();
  });
});

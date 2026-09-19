// 寻址终态测试（docs/AGENT-DELEGATION.md §5.2——修订A「去名」：agentId 唯一身份）：
// main 通道（子→父信封/根拒）、agentId 精确、未知形态引导、task_id 按号、block/timeout。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmChunk } from "@x-harness/llm";
import { sessionStore } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, typesOf, agentIdOf } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const userTextsOf = (world: World, session: Parameters<typeof userTextsOfWorld>[1]): string => userTextsOfWorld(world, session);

function userTextsOfWorld(world: World, session: import("@x-harness/session").SessionId): string {
  return world.ctx
    .use(sessionStore)
    .get(session)
    ?.events()
    .filter((e) => e.type === "user/message")
    .map((e) => JSON.stringify(e.data))
    .join("\n") ?? "";
}

const turnEndsOf = (world: World, session: import("@x-harness/session").SessionId): number =>
  world.ctx.use(sessionStore).get(session)?.events().filter((e) => e.type === "turn/end").length ?? 0;

describe("agentId 寻址（§5.2——修订A）", () => {
  it("agentId 精确投递；未知裸名/怪形态 → not-found 带形态引导", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as import("@x-harness/session").SessionId;
    await vi.waitFor(() => expect(turnEndsOf(world, childSession)).toBe(1), { timeout: 5_000 });
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "two")]);
    const sent = await callTool({ world, name: "agent_message", args: { to: agentId, message: "wake" }, session: parent.agent.session.id });
    expect(sent.isError).toBeUndefined();
    await vi.waitFor(() => expect(turnEndsOf(world, childSession)).toBe(2), { timeout: 5_000 });
    expect(userTextsOf(world, childSession)).toContain("wake"); // 身份对账：收件到位
    const unknown = await callTool({ world, name: "agent_message", args: { to: "researcher", message: "hi" }, session: parent.agent.session.id });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("not-found:researcher");
    expect(unknown.content).toContain("agent-<hex>");
    await parent.dispose();
  });

  it("两子并存：agentId 互异且各自独立投递（修订A——无名字无歧义）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 5 }));
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "a1"), textScript(CHILD_MODEL, "a2"), textScript(CHILD_MODEL, "b1"), textScript(CHILD_MODEL, "b2")]);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "task a", prompt: "a", subagent_type: "worker" }, session: parent.agent.session.id });
    const second = await callTool({ world, name: "agent_spawn", args: { description: "task b", prompt: "b", subagent_type: "worker" }, session: parent.agent.session.id });
    const idA = agentIdOf(first.content);
    const idB = agentIdOf(second.content);
    expect(idA).not.toBe(idB);
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain(idA);
    expect(listed.content).toContain(idB);
    const sessionA = (first.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as import("@x-harness/session").SessionId;
    const sessionB = (second.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as import("@x-harness/session").SessionId;
    await vi.waitFor(() => expect(turnEndsOf(world, sessionA) + turnEndsOf(world, sessionB)).toBe(2), { timeout: 5_000 });
    await callTool({ world, name: "agent_message", args: { to: idA, message: "for a" }, session: parent.agent.session.id });
    await callTool({ world, name: "agent_message", args: { to: idB, message: "for b" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(turnEndsOf(world, sessionA)).toBe(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(turnEndsOf(world, sessionB)).toBe(2), { timeout: 5_000 });
    expect(userTextsOf(world, sessionA)).toContain("for a");
    expect(userTextsOf(world, sessionB)).toContain("for b");
    await parent.dispose();
  });
});

describe("main 通道（§5.1/§5.2-1）", () => {
  it("子代理 agent_message{to:'main'} → 父会话收 <cross-session-message from=子agentId>", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "ack"), textScript(PARENT_MODEL, "parent consumed child message")]);
    world.scripts.set(CHILD_MODEL, [
      textScript(CHILD_MODEL, "child done"),
      (async function* (): AsyncGenerator<LlmChunk> {
        yield { type: "tool-call-delta", index: 0, callId: "m1", name: "agent_message", argumentsDelta: JSON.stringify({ to: "main", message: "child asking parent" }) };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "work", subagent_type: "worker" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as import("@x-harness/session").SessionId;
    await vi.waitFor(() => expect(turnEndsOf(world, childSession)).toBe(1), { timeout: 5_000 });
    const woke = await callTool({ world, name: "agent_message", args: { to: agentId, message: "report to main" }, session: parent.agent.session.id });
    expect(woke.isError).toBeUndefined();
    await vi.waitFor(() => {
      // userTextsOf 是 JSON.stringify 空间——内层引号被转义，按转义形态断言
      expect(userTextsOf(world, parent.agent.session.id)).toContain(`<cross-session-message from=\\"${agentId}\\">child asking parent</cross-session-message>`);
    }, { timeout: 5_000 });
    const turnStartCount = (): number => typesOf(parent).filter((t: string) => t === "turn/start").length;
    await vi.waitFor(() => expect(turnStartCount()).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
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

describe("task_id 按号（output/stop）与 block/timeout", () => {
  it("output/stop 按 agentId 生效（owner 限定）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } }, { maxConcurrent: 5 }));
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one"), textScript(CHILD_MODEL, "two")]);
    const first = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker" }, session: parent.agent.session.id });
    const idA = agentIdOf(first.content);
    const stopped = await callTool({ world, name: "task_stop", args: { task_id: idA }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    const listed = await callTool({ world, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("status=stopped");
    const output = await callTool({ world, name: "task_output", args: { task_id: idA, block: false }, session: parent.agent.session.id });
    expect(output.isError).toBeUndefined();
    expect(output.content).toContain(idA);
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
    const waited = await callTool({ world, name: "task_output", args: { task_id: agentId, block: true, timeout: 50 }, session: parent.agent.session.id });
    expect(waited.isError).toBeUndefined();
    expect(waited.content).toContain("still running");
    expect(waited.content).toContain("waited 50ms");
    release();
    const done = await callTool({ world, name: "task_output", args: { task_id: agentId, block: true, timeout: 5_000 }, session: parent.agent.session.id });
    expect(done.content).toContain("completed");
    expect(done.content).toContain("slow child finished");
    await parent.dispose();
  });
});

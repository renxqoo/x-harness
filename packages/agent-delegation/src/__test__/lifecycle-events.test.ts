import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, workerOptions, resetWorlds, agentIdOf, sessionOf } from "./world.ts";
import { agentFinished, agentSpawned } from "../tokens.ts";
import type { AgentFinishedPayload, AgentSpawnedPayload } from "../tokens.ts";

beforeEach(() => {
  resetWorlds();
});

interface EventLog {
  spawned: AgentSpawnedPayload[];
  finished: AgentFinishedPayload[];
}

function wireLog(ctx: import("@x-harness/core").Context): EventLog {
  const log: EventLog = { spawned: [], finished: [] };
  ctx.on(agentSpawned, (payload) => log.spawned.push(payload));
  ctx.on(agentFinished, (payload) => log.finished.push(payload));
  return log;
}

describe("agentSpawned/agentFinished 发射矩阵", () => {
  it("正常完成：spawned 一发 + finished{completed} 一发（detail=completed，summary 全文透传）", async () => {
    const world = await makeWorld(await workerOptions());
    const log = wireLog(world.ctx);
    const parent = await spawnParent(world);
    const full = `${"z".repeat(250)}-tail`;
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, full)]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(log.finished).toHaveLength(1), { timeout: 5_000 });
    expect(log.spawned).toHaveLength(1);
    expect(log.spawned[0]).toMatchObject({ parent: parent.agent.session.id, agentId: agentIdOf(spawned.content), sessionId: sessionOf(spawned.content), type: "worker", depth: 1 });
    expect(log.finished[0]).toMatchObject({ outcome: "completed", detail: "completed", agentId: agentIdOf(spawned.content) });
    expect(log.finished[0]?.summary).toBe(full);
    await parent.dispose();
  });

  it("stopAll 级联：finished{stopped}（经 armed-idle 单点 deliver）", async () => {
    const world = await makeWorld(await workerOptions());
    const log = wireLog(world.ctx);
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [
      (async function* (): AsyncGenerator<import("@x-harness/llm").LlmChunk> {
        await new Promise((resolve) => {
          setTimeout(resolve, 400);
        });
        yield { type: "text-delta", text: "slow" };
        yield { type: "finish", finish: { kind: "stop" } };
      })(),
    ]);
    await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(log.spawned).toHaveLength(1), { timeout: 5_000 });
    const view = world.ctx.tryUse((await import("../view.ts")).delegationView);
    expect(view).toBeDefined();
    await view?.stopAll(parent.agent.session.id, "test-stop");
    await vi.waitFor(() => expect(log.finished).toHaveLength(1), { timeout: 5_000 });
    expect(log.finished[0]).toMatchObject({ outcome: "stopped", detail: "test-stop" });
    await parent.dispose();
  });

  it("stop idle 子：无 armed-idle 边沿——finished{stopped} 同步发射（回归 BATCH2 审 L4）", async () => {
    const world = await makeWorld(await workerOptions());
    const log = wireLog(world.ctx);
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "quick")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(log.finished).toHaveLength(1), { timeout: 5_000 });
    log.finished.length = 0;
    const agentId = agentIdOf(spawned.content);
    const stopped = await callTool({ world, name: "task_stop", args: { task_id: agentId, cause: "manual" }, session: parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    expect(log.finished).toHaveLength(1);
    expect(log.finished[0]).toMatchObject({ outcome: "stopped" });
    expect(typeof log.finished[0]?.detail).toBe("string");
    expect(log.finished[0]?.detail).not.toBe("");
    const again = await callTool({ world, name: "task_stop", args: { task_id: agentId }, session: parent.agent.session.id });
    expect(again.content).toContain("already stopped");
    expect(log.finished).toHaveLength(1);
    await parent.dispose();
  });

  it("孤儿子收养：deliver 单点发射 finished{failed}（parent session gone）", async () => {
    const world = await makeWorld(await workerOptions());
    const log = wireLog(world.ctx);
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "orphan work")]);
    await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    await vi.waitFor(() => expect(log.spawned).toHaveLength(1), { timeout: 5_000 });
    await parent.dispose();
    await vi.waitFor(() => expect(log.finished).toHaveLength(1), { timeout: 5_000 });
    expect(log.finished[0]).toMatchObject({ outcome: "failed", detail: "parent session gone (agent stopped)" });
  });

  it("复活再运行：finished 每运行周期一次（首周期 completed → 复活唤醒再 completed）", async () => {
    const world = await makeWorld(await workerOptions());
    const log = wireLog(world.ctx);
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "first cycle")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    await vi.waitFor(() => expect(log.finished).toHaveLength(1), { timeout: 5_000 });
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "ok")]);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "second cycle")]);
    const messaged = await callTool({ world, name: "agent_message", args: { to: agentId, message: "again" }, session: parent.agent.session.id });
    expect(messaged.isError).toBeUndefined();
    await vi.waitFor(() => expect(log.finished).toHaveLength(2), { timeout: 5_000 });
    expect(log.finished[1]).toMatchObject({ outcome: "completed", detail: "completed" });
    await parent.dispose();
  });
});

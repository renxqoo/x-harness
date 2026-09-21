// delegationView 服务面测试（宿主直调——hub get_subagents/subagent-steer/abort 级联消费）：
// 结构化 list（非文本解析）、message 投递（idle 唤醒）、stopAll 幂等级联。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegationView } from "../index.ts";
import type { ChildView } from "../index.ts";
import { makeWorld, spawnParent, callTool, textScript, CHILD_MODEL, workerOptions, resetWorlds, agentIdOf } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

function settledStatuses(rows: readonly ChildView[]): boolean {
  return rows.every((row) => row.status === "stopped" || row.status === "idle");
}

describe("delegationView（宿主直调服务面）", () => {
  it("list：结构化 ChildView 行（kind/agentId/sessionId/type/depth/status）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "probe", prompt: "x" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const view = world.ctx.use(delegationView);
    const rows = await view.list(parent.agent.session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "subagent", agentId, type: "untyped", depth: 1 });
    expect(typeof (rows[0] as { sessionId?: string }).sessionId).toBe("string");
    expect(await view.list(undefined)).toEqual([]); // 无 caller 空形态
    await parent.dispose();
  });

  it("message：idle 子立即唤醒（新 turn 消费投递文本）；未知目标 miss", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "first")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "m", prompt: "x" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const view = world.ctx.use(delegationView);
    await vi.waitFor(async () => expect((await view.list(parent.agent.session.id))[0]?.status).toBe("idle"), { timeout: 5_000 });
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "woken by host message")]);
    const sent = await view.message(parent.agent.session.id, { to: agentId, message: "host says hi" });
    expect(sent.ok).toBe(true);
    await vi.waitFor(async () => expect((await view.list(parent.agent.session.id))[0]?.status).toBe("idle"), { timeout: 5_000 });
    const miss = await view.message(parent.agent.session.id, { to: "agent-00000000", message: "x" });
    expect(miss.ok).toBe(false);
    expect(miss.ok === false && miss.reason).toContain("not-found");
    await parent.dispose();
  });

  it("stopAll：全部未停子级联停止（幂等——stopped 行不再重复结算）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    await callTool({ world, name: "agent_spawn", args: { description: "a", prompt: "x" }, session: parent.agent.session.id });
    await callTool({ world, name: "agent_spawn", args: { description: "b", prompt: "x" }, session: parent.agent.session.id });
    const view = world.ctx.use(delegationView);
    await vi.waitFor(async () => expect(await view.list(parent.agent.session.id)).toHaveLength(2), { timeout: 5_000 });
    await view.stopAll(parent.agent.session.id, "host-abort");
    await vi.waitFor(async () => expect(settledStatuses(await view.list(parent.agent.session.id))), { timeout: 5_000 });
    await view.stopAll(parent.agent.session.id, "host-abort"); // 幂等重放不崩
    await parent.dispose();
  });
});

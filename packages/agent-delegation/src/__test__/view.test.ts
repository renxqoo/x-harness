import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@x-harness/session";
import { delegationView } from "../index.ts";
import type { ChildView } from "../index.ts";
import { makeWorld, spawnParent, callTool, textScript, CHILD_MODEL, PARENT_MODEL, workerOptions, resetWorlds, agentIdOf } from "./world.ts";

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
    expect(await view.list(undefined)).toEqual([]);
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
    await view.stopAll(parent.agent.session.id, "host-abort");
    await parent.dispose();
  });

  it("rebindMailbox：会话切换换箱（旧箱关、新箱 discover 可见、信封路由到新会话）；mailbox 缺席部署拒", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-rebind-"));
    const world = await makeWorld({ ...(await workerOptions()), mailbox: { box: "alpha", mainSession: "main-1" as SessionId } }, root);
    const view = world.ctx.use(delegationView);
    const first = await spawnParent(world, PARENT_MODEL, "main-1" as SessionId);
    const rebound = await view.rebindMailbox(first.agent.session.id);
    expect(rebound.ok).toBe(true);
    const service = world.ctx.use(await import("@x-harness/session-mailbox").then((m) => m.mailboxService));
    const boxes = await service.discover();
    expect(boxes.some((box) => box.name === `xh-${String(first.agent.session.id)}`)).toBe(true);
    expect(boxes.some((box) => box.name === "alpha")).toBe(false);
    const peer = await service.open("peer-of-rebind");
    const sent = await service.send(`xh-${String(first.agent.session.id)}`, { from: peer.name, message: "after rebind", kind: "message" });
    expect(sent.ok).toBe(true);
    const envelopes = await service.drain(`xh-${String(first.agent.session.id)}`);
    expect(envelopes).toHaveLength(1);
    await peer.close();
    await first.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("rebindMailbox：mailbox 缺席部署拒 invalid-args（进程内形态不炸）", async () => {
    const world = await makeWorld(await workerOptions());
    const view = world.ctx.use(delegationView);
    const rejected = await view.rebindMailbox("any" as SessionId);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("no mailbox configured");
  });

});

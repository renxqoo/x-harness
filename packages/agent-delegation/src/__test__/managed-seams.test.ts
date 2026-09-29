import { beforeEach, describe, expect, it, vi } from "vitest";
import { delegationView } from "../index.ts";
import type { ManagedCycleReport, SettlementSink } from "../tokens.ts";
import { makeWorld, makeOptions, spawnParent, callTool, textScript, PARENT_MODEL, workerOptions, resetWorlds, agentIdOf } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

async function waitForNotification(parent: Awaited<ReturnType<typeof spawnParent>>, timeout = 5_000): Promise<void> {
  await vi.waitFor(() => {
    expect(parent.agent.session.events().some((event) => JSON.stringify(event.data).includes("agent-notification"))).toBe(true);
  }, { timeout });
}

function collector(): { readonly sink: SettlementSink; readonly reports: ManagedCycleReport[] } {
  const reports: ManagedCycleReport[] = [];
  return { sink: { onCycleEnd: (report) => reports.push(report) }, reports };
}

async function managedFixture() {
  const world = await makeWorld(await workerOptions());
  const parent = await spawnParent(world);
  const { sink, reports } = collector();
  return { world, parent, sink, reports };
}

describe("接缝① spawnManaged", () => {
  it("受管 spawn：settlement 挂行、完成投 sink 不直达父", async () => {
    const { world, parent, sink, reports } = await managedFixture();
    const view = world.ctx.use(delegationView);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "managed work", prompt: "do it", settlement: sink });
    expect(spawned.ok).toBe(true);
    const agentId = spawned.ok ? agentIdOf(spawned.text) : "";
    expect(agentId).toMatch(/^agent-[0-9a-f]{8}$/);

    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "done")]);
    await vi.waitFor(() => expect(reports.length).toBe(1), { timeout: 5_000 });
    expect(reports[0]?.agentId).toBe(agentId);
    expect(reports[0]?.outcome).toBe("completed");
    expect(reports[0]?.summary).toBe("done");
    const parentText = (parent.agent.session.events().map((e) => JSON.stringify(e.data)).join("\n"));
    expect(parentText).not.toContain("agent-notification");
    await parent.dispose();
  });

  it("普通 spawn 路径不回归：无 settlement 行通知照旧直达父", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "plain done")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "plain", prompt: "x" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined();
    await waitForNotification(parent);
    await parent.dispose();
  });

  it("spawn 校验链共享：空 description 拒（与工具面同词表）", async () => {
    const { world, parent, sink } = await managedFixture();
    const view = world.ctx.use(delegationView);
    const rejected = await view.spawnManaged(parent.agent.session.id, { description: "  ", prompt: "x", settlement: sink });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok === false && rejected.reason).toContain("invalid-args:description");
    await parent.dispose();
  });
});

describe("接缝④-1/2：收养与档化豁免", () => {
  it("父 dispose 后受管子不被收养处置（W8）：sink 仍可收完成报告", async () => {
    const { world, parent, sink, reports } = await managedFixture();
    const view = world.ctx.use(delegationView);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "late finish")]);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "survivor", prompt: "work", settlement: sink });
    expect(spawned.ok).toBe(true);
    await parent.dispose();
    await vi.waitFor(() => expect(reports.length).toBe(1), { timeout: 5_000 });
    expect(reports[0]?.summary).toBe("late finish");
  });

  it("message 到受管行：父缺席不触发收养（豁免 deliverToRow 预检）——父真 dispose", async () => {
    const { world, parent, sink, reports } = await managedFixture();
    const view = world.ctx.use(delegationView);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "first done")]);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "managed", prompt: "work", settlement: sink });
    expect(spawned.ok).toBe(true);
    const agentId = spawned.ok ? agentIdOf(spawned.text) : "";
    await vi.waitFor(() => expect(reports.length).toBe(1), { timeout: 5_000 });
    await parent.dispose();
    const sent = await view.message(parent.agent.session.id, { to: agentId, message: "extra instruction" });
    expect(sent.ok).toBe(true);
  });
});

describe("接缝③ settle", () => {
  it("settle 受管行：cancel + 行摘除 + 幂等 miss", async () => {
    const { world, parent, sink } = await managedFixture();
    const view = world.ctx.use(delegationView);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "to stop", prompt: "work", settlement: sink });
    expect(spawned.ok).toBe(true);
    const agentId = spawned.ok ? agentIdOf(spawned.text) : "";
    const settled = await view.settle(agentId, "workflow-done");
    expect(settled.ok).toBe(true);
    const listed = await view.list(parent.agent.session.id);
    expect(listed.some((row) => row.kind === "subagent" && row.agentId === agentId)).toBe(false);
    await parent.dispose();
  });
});

describe("接缝② reviveManaged", () => {
  it("无 archive 部署：miss（fail-closed 同 message 复活链）", async () => {
    const { world, parent, sink } = await managedFixture();
    const view = world.ctx.use(delegationView);
    const outcome = await view.reviveManaged(parent.agent.session.id, "agent-00000000", sink);
    expect(outcome.kind).toBe("miss");
    await parent.dispose();
  });
});

describe("接缝④-4：stopAll 与级联豁免", () => {
  it("stopAll 跳过受管行（普通行照停）", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const { sink } = collector();
    const view = world.ctx.use(delegationView);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "a"), textScript(PARENT_MODEL, "b")]);
    const managed = await view.spawnManaged(parent.agent.session.id, { description: "managed", prompt: "x", settlement: sink });
    const plain = await callTool({ world, name: "agent_spawn", args: { description: "plain", prompt: "y" }, session: parent.agent.session.id });
    const managedId = managed.ok ? agentIdOf(managed.text) : "";
    const plainId = agentIdOf(plain.content);
    await view.stopAll(parent.agent.session.id, "host-stop");
    const rows = await view.list(parent.agent.session.id);
    const managedRow = rows.find((row) => row.kind === "subagent" && row.agentId === managedId);
    const plainRow = rows.find((row) => row.kind === "subagent" && row.agentId === plainId);
    expect((managedRow as { status?: string } | undefined)?.status).not.toBe("stopped");
    expect((plainRow as { status?: string } | undefined)?.status).toBe("stopped");
    await view.settle(managedId, "cleanup");
    await parent.dispose();
  });

  it("插件 dispose 级联豁免：拆卸期受管行不在级联 cancel 名单（拆卸不 throw、子会话 WAL 在盘）", async () => {
    const { world, parent, sink, reports } = await managedFixture();
    const view = world.ctx.use(delegationView);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "cascade window")]);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "managed", prompt: "x", settlement: sink });
    expect(spawned.ok).toBe(true);
    const childSession = spawned.ok ? (spawned.text.match(/session (\S+?)\)/)?.[1] ?? "") : "";
    const child = world.loop.get(childSession as never);
    expect(child).toBeDefined();
    await world.disposePlugins();
    expect(reports.length).toBe(0);
  });
});

describe("接缝④-2：档化豁免（evictIdle）", () => {
  it("maxResident=1 压迫：受管行不被档化摘行（普通行会）", async () => {
    const options = await makeOptions({ worker: { model: PARENT_MODEL, body: "w" } }, { maxResident: 1, maxConcurrent: 5 });
    const world = await makeWorld(options);
    const parent = await spawnParent(world);
    const { sink } = collector();
    const view = world.ctx.use(delegationView);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "done once")]);
    const spawned = await view.spawnManaged(parent.agent.session.id, { description: "managed", prompt: "x", settlement: sink });
    expect(spawned.ok).toBe(true);
    const agentId = spawned.ok ? agentIdOf(spawned.text) : "";
    await vi.waitFor(() => rowVisible(view, parent.agent.session.id, agentId), { timeout: 5_000 });
    const listed = await view.list(parent.agent.session.id);
    expect(listed.some((row) => row.kind === "subagent" && row.agentId === agentId)).toBe(true);
    await view.settle(agentId, "cleanup");
    await parent.dispose();
  });
});

async function rowVisible(view: import("../index.ts").DelegationView, caller: import("@x-harness/session").SessionId, agentId: string): Promise<void> {
  const rows = await view.list(caller);
  if (!rows.some((row) => row.kind === "subagent" && row.agentId === agentId)) throw new Error("row not visible");
}

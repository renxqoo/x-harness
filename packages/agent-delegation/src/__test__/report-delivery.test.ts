// 报告全文单次交付口径：完成通知是唯一交付点（steer 成功置 reportDelivered），
// task_output 复查让位为状态头 + 指针——同份报告只进父上下文一次；通知未交付的
// 异常窗口（steer 失败/tearing-down——reportDelivered 未置）task_output 仍全文兜底。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, SessionId } from "@x-harness/session";
import { sessionStore } from "@x-harness/session";
import { output as outputVerb } from "../verbs.ts";
import { createLineage } from "../lineage.ts";
import type { World } from "./world.ts";
import { makeWorld, spawnParent, callTool, textScript, CHILD_MODEL, makeOptions, workerOptions, resetWorlds, agentIdOf, sessionOf } from "./world.ts";

const eventsOf = (world: World, session: SessionId): readonly ReturnType<Session["events"]>[number][] => {
  const found = world.ctx.use(sessionStore).get(session);
  return found === undefined ? [] : found.events();
};

const childEnded = (world: World, session: SessionId): boolean => eventsOf(world, session).some((e) => e.type === "turn/end");

beforeEach(() => {
  resetWorlds();
});

describe("报告全文单次交付", () => {
  it("完成通知直送全文（与 reportCap 同一上界）；task_output 复查不复读（同份内容只进父上下文一次）", async () => {
    const world = await makeWorld(await makeOptions({ worker: { model: CHILD_MODEL } })); // 缺省 reportCap 34000
    const parent = await spawnParent(world);
    const long = "y".repeat(300);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, long)]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    const lastNotice = (): string => JSON.stringify(parent.agent.session.events().filter((e) => e.type === "agent/message").at(-1)?.data);
    await vi.waitFor(() => expect(lastNotice()).toContain(`summary: ${long}`), { timeout: 5_000 }); // 通知即全文
    expect(lastNotice()).not.toContain("truncated at");
    expect(lastNotice()).not.toContain("task_output"); // 不再引导二次调用取报告
    const output = await callTool({ world, name: "task_output", args: { task_id: agentId, block: true }, session: parent.agent.session.id });
    expect(output.content).toContain("already delivered"); // 全文已随通知交付——task_output 不复读
    expect(output.content).not.toContain(long);
    await parent.dispose();
  });

  it("task_output 全文兜底：完成态但通知未交付（steer 失败/tearing-down 窗口——reportDelivered 未置）→ 复查仍给全文", async () => {
    const world = await makeWorld(await workerOptions());
    const parent = await spawnParent(world);
    const long = "w".repeat(150);
    world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, long)]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: parent.agent.session.id });
    const agentId = agentIdOf(spawned.content);
    const childSession = sessionOf(spawned.content);
    await vi.waitFor(() => expect(childEnded(world, childSession)).toBe(true), { timeout: 5_000 });
    // 手工动词依赖：血缘指向同一子会话但 reportDelivered=false（模拟通知投递失败窗口）
    const fakeRow = { agentId, sessionId: childSession, type: "worker", parent: parent.agent.session.id, depth: 1, occupied: false, armed: false, running: false, stopped: false, reportDelivered: false };
    const handLineage = createLineage();
    handLineage.register(fakeRow);
    const handDeps = {
      loop: { get: () => ({ agent: { whenIdle: () => Promise.resolve() } }) },
      store: world.ctx.use(sessionStore),
      lineage: handLineage,
      reportCap: 1000,
      adoptOrphan: async () => {},
      emitFinished: () => {},
    } as never as Parameters<typeof outputVerb>[0];
    const out = await outputVerb(handDeps, parent.agent.session.id, { task_id: agentId, block: false });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain(long); // 未交付 → 全文兜底，报告不因通知异常而丢失
    await parent.dispose();
  });
});

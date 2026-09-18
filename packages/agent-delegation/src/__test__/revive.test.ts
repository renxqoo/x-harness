// archive 惰性复活与驻留档化测试（docs/AGENT-DELEGATION.md §6.2/§2.2/§11.2）：
// 重启模拟（ctx 销毁重建 + 同 root jsonl 档案）、同 sessionId 续卷、类型/白名单重建、
// 类型定义丢失 fail-closed、同名歧义、maxResident 最旧档化。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStore } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, resetWorlds, sessionOf } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

async function persistedWorld(root: string, over: Parameters<typeof makeOptions>[1] = {}, withParent = true): Promise<{ world: World; parent: Awaited<ReturnType<typeof spawnParent>> }> {
  const options = await makeOptions({ worker: { model: CHILD_MODEL, body: "you are the worker" } }, over);
  const world = await makeWorld(options, undefined, [createJsonlSessionPersistence({ root })]);
  const parent = withParent ? await spawnParent(world, PARENT_MODEL, "p1" as never) : undefined;
  return { world, parent: parent as Awaited<ReturnType<typeof spawnParent>> };
}

describe("archive 惰性复活（§6.2）", () => {
  it("重启后按名复活：同 sessionId 续卷、类型 systemPrompt 重建、完成通知达复活父", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-revive-"));
    try {
      const first = await persistedWorld(root);
      first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "first life"), textScript(CHILD_MODEL, "second life")]);
      first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p"), textScript(PARENT_MODEL, "p2"), textScript(PARENT_MODEL, "p3")]);
      const spawned = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "work", subagent_type: "worker", name: "sleeper" }, session: first.parent.agent.session.id });
      const childSession = sessionOf(spawned.content);
      const turnEnds = (): number => first.world.ctx.use(sessionStore).get(childSession)?.events().filter((e) => e.type === "turn/end").length ?? 0;
      await vi.waitFor(() => expect(turnEnds()).toBe(1), { timeout: 5_000 });
      await first.world.ctx.use(sessionStore).flush(childSession);
      await first.world.ctx.use(sessionStore).flush(first.parent.agent.session.id);
      await first.world.disposePlugins(); // 模拟进程消失（子 dispose、lineage 蒸发）

      const second = await persistedWorld(root, {}, false); // 不建父——父从档案 resume
      second.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "awake again")]);
      second.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "second life")]);
      const resumed = await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      expect(resumed.ok).toBe(true);
      const woke = await callTool({ world: second.world, name: "agent_message", args: { to: "sleeper", message: "wake up" }, session: first.parent.agent.session.id });
      expect(woke.isError).toBeUndefined(); // in-process miss → archive 复活命中
      // 同 sessionId 续卷（档案 resume，非新建）
      const listed = await callTool({ world: second.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
      expect(listed.content).toContain(childSession);
      const turnEnds2 = (): number => second.world.ctx.use(sessionStore).get(childSession)?.events().filter((e) => e.type === "turn/end").length ?? 0;
      await vi.waitFor(() => expect(turnEnds2()).toBe(2), { timeout: 5_000 }); // 第二轮完成（续卷非重开）
      const childEvents = second.world.ctx.use(sessionStore).get(childSession)?.events() ?? [];
      expect(JSON.stringify(childEvents)).toContain("you are the worker"); // 类型 systemPrompt 重建
      expect(JSON.stringify(childEvents)).toContain("second life");
      await second.world.disposePlugins();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("类型定义丢失 → fail-closed 不复活（not-found）；同名两档案 → 不复活", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-revive2-"));
    try {
      const first = await persistedWorld(root, { maxConcurrent: 5 });
      first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "a"), textScript(CHILD_MODEL, "b")]);
      const one = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker", name: "twin9" }, session: first.parent.agent.session.id });
      const two = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "y", subagent_type: "worker", name: "twin9" }, session: first.parent.agent.session.id });
      for (const s of [sessionOf(one.content), sessionOf(two.content), first.parent.agent.session.id]) {
        await first.world.ctx.use(sessionStore).flush(s);
      }
      await first.world.disposePlugins();

      const second = await persistedWorld(root);
      await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const ambiguous = await callTool({ world: second.world, name: "agent_message", args: { to: "twin9", message: "hi" }, session: first.parent.agent.session.id });
      expect(ambiguous.isError).toBe(true); // 同名两档案 → ambiguous 词表（审查 A-P2-6 处置）
      expect(ambiguous.content).toContain("ambiguous:twin9");

      // 删掉类型文件 → 类型定义丢失 fail-closed：用唯一名重建场景
      const thirdRoot = await mkdtemp(join(tmpdir(), "xh-revive3-"));
      const before = await persistedWorld(thirdRoot);
      before.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "z")]);
      const spawned = await callTool({ world: before.world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker", name: "lonely" }, session: before.parent.agent.session.id });
      await before.world.ctx.use(sessionStore).flush(sessionOf(spawned.content));
      await before.world.ctx.use(sessionStore).flush(before.parent.agent.session.id);
      const agentsDir = (await makeOptions({})).agentsDirs?.[0] as string; // 无 worker 定义的新目录
      await before.world.disposePlugins();

      const after = await makeWorld({ agentsDirs: [agentsDir] }, undefined, [createJsonlSessionPersistence({ root: thirdRoot })]);
      await after.loop.resume({ id: before.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const noType = await callTool({ world: after, name: "agent_message", args: { to: "lonely", message: "hi" }, session: before.parent.agent.session.id });
      expect(noType.isError).toBe(true); // worker .md 不在新目录 → 不降级复活
      await after.disposePlugins();
      await rm(thirdRoot, { recursive: true, force: true }).catch(() => {});
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("驻留档化（§2.2 maxResident）", () => {
  it("idle 子超上限 → 最旧 dispose（会话可档化，lineage 摘行）", async () => {
    const first = await persistedWorld(await mkdtemp(join(tmpdir(), "xh-evict-")), { maxResident: 1, maxConcurrent: 5 });
    first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one"), textScript(CHILD_MODEL, "two")]);
    const a = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker", name: "alpha" }, session: first.parent.agent.session.id });
    const b = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "b", subagent_type: "worker", name: "beta" }, session: first.parent.agent.session.id });
    const sessionA = sessionOf(a.content);
    const sessionB = sessionOf(b.content);
    const doneB = (): boolean => (first.world.ctx.use(sessionStore).get(sessionB)?.events().some((e) => e.type === "turn/end")) ?? false;
    await vi.waitFor(() => expect(doneB()).toBe(true), { timeout: 5_000 });
    // 第二子完成后：驻留 1——最旧 alpha 被档化（loop 摘除），beta 仍驻留
    await vi.waitFor(() => expect(first.world.loop.get(sessionA)).toBeUndefined(), { timeout: 5_000 });
    expect(first.world.loop.get(sessionB)).toBeDefined();
    const listed = await callTool({ world: first.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
    expect(listed.content).not.toContain(sessionA);
    expect(listed.content).toContain(sessionB);
    await first.world.disposePlugins();
  });
});

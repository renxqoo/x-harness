// archive 惰性复活与驻留档化测试（docs/AGENT-DELEGATION.md §6.2/§2.2——修订A「去名」：
// 按 agentId 复活、id 跨重启稳定）：重启模拟（ctx 销毁重建 + 同 root jsonl 档案）、
// 同 sessionId 续卷、id 不变、类型/白名单重建、类型定义丢失 fail-closed、maxResident 最旧档化。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, resetWorlds, sessionOf } from "./world.ts";
import type { World } from "./world.ts";

beforeEach(() => {
  resetWorlds();
});

const turnEndCount = (world: World, session: SessionId): number =>
  world.ctx.use(sessionStore).get(session)?.events().filter((e: { type: string }) => e.type === "turn/end").length ?? 0;

const hasTurnEnd = (world: World, session: SessionId): boolean =>
  world.ctx.use(sessionStore).get(session)?.events().some((e: { type: string }) => e.type === "turn/end") ?? false;

async function persistedWorld(root: string, over: Parameters<typeof makeOptions>[1] = {}, withParent = true): Promise<{ world: World; parent: Awaited<ReturnType<typeof spawnParent>> }> {
  const options = await makeOptions({ worker: { model: CHILD_MODEL, body: "you are the worker" } }, over);
  const world = await makeWorld(options, undefined, [createJsonlSessionPersistence({ root })]);
  const parent = withParent ? await spawnParent(world, PARENT_MODEL, "p1" as never) : undefined;
  return { world, parent: parent as Awaited<ReturnType<typeof spawnParent>> };
}

describe("archive 惰性复活（§6.2——修订A：按 agentId）", () => {
  it("重启后按 agentId 复活：同 sessionId 续卷、id 不变、类型 systemPrompt 重建", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-revive-"));
    try {
      const first = await persistedWorld(root);
      first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "first life"), textScript(CHILD_MODEL, "second life")]);
      first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p"), textScript(PARENT_MODEL, "p2"), textScript(PARENT_MODEL, "p3")]);
      const spawned = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "work", subagent_type: "worker" }, session: first.parent.agent.session.id });
      const agentId = (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] as string;
      const childSession = sessionOf(spawned.content);
      await vi.waitFor(() => {
        expect(turnEndCount(first.world, childSession)).toBe(1);
      }, { timeout: 5_000 });
      await first.world.ctx.use(sessionStore).flush(childSession);
      await first.world.ctx.use(sessionStore).flush(first.parent.agent.session.id);
      await first.world.disposePlugins(); // 模拟进程消失（子 dispose、lineage 蒸发）

      const second = await persistedWorld(root, {}, false); // 不建父——父从档案 resume
      second.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "awake again")]);
      second.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "second life")]);
      const resumed = await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      expect(resumed.ok).toBe(true);
      const woke = await callTool({ world: second.world, name: "agent_message", args: { to: agentId, message: "wake up" }, session: first.parent.agent.session.id });
      expect(woke.isError).toBeUndefined(); // in-process miss → archive 按 id 复活命中
      expect(woke.content).toContain(agentId); // id 不变（返回文案即证）
      const listed = await callTool({ world: second.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
      expect(listed.content).toContain(childSession); // 同 sessionId 续卷（档案 resume，非新建）
      await vi.waitFor(() => {
        expect(turnEndCount(second.world, childSession)).toBe(2); // 第二轮完成（续卷非重开）
      }, { timeout: 5_000 });
      const childEvents = second.world.ctx.use(sessionStore).get(childSession)?.events() ?? [];
      expect(JSON.stringify(childEvents)).toContain("you are the worker"); // 类型 systemPrompt 重建
      expect(JSON.stringify(childEvents)).toContain("second life");
      await second.world.disposePlugins();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("类型定义丢失 → fail-closed 不复活（not-found）；未知 agentId → not-found", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-revive2-"));
    try {
      const first = await persistedWorld(root);
      first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "z")]);
      const spawned = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "x", subagent_type: "worker" }, session: first.parent.agent.session.id });
      const agentId = (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] as string;
      await first.world.ctx.use(sessionStore).flush(sessionOf(spawned.content));
      await first.world.ctx.use(sessionStore).flush(first.parent.agent.session.id);
      await first.world.disposePlugins();

      // 类型定义丢失：新装配的 agents 目录无 worker 定义
      const emptyDirOptions = await makeOptions({});
      const agentsDir = emptyDirOptions.agentsDirs?.[0] as string;
      const after = await makeWorld({ agentsDirs: [agentsDir] }, undefined, [createJsonlSessionPersistence({ root })]);
      await after.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const noType = await callTool({ world: after, name: "agent_message", args: { to: agentId, message: "hi" }, session: first.parent.agent.session.id });
      expect(noType.isError).toBe(true); // worker .md 不在 → 不降级复活
      expect(noType.content).toContain("not-found");
      await after.disposePlugins();

      // 未知 agentId：正常装配也不复活
      const second = await persistedWorld(root, {}, false);
      await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const ghost = await callTool({ world: second.world, name: "agent_message", args: { to: "agent-00000000", message: "hi" }, session: first.parent.agent.session.id });
      expect(ghost.isError).toBe(true);
      expect(ghost.content).toContain("not-found");
      await second.world.disposePlugins();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("驻留档化（§2.2 maxResident）", () => {
  it("idle 子超上限 → 最旧 dispose；纯内存部署（无 archive）跳过档化不毁约", async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-evict-"));
    try {
      const first = await persistedWorld(root, { maxResident: 1, maxConcurrent: 5 });
      first.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      first.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one"), textScript(CHILD_MODEL, "two")]);
      const a = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker" }, session: first.parent.agent.session.id });
      const b = await callTool({ world: first.world, name: "agent_spawn", args: { description: "d", prompt: "b", subagent_type: "worker" }, session: first.parent.agent.session.id });
      const sessionA = sessionOf(a.content);
      const sessionB = sessionOf(b.content);
      await vi.waitFor(() => {
        expect(hasTurnEnd(first.world, sessionB)).toBe(true);
      }, { timeout: 5_000 });
      // 第二子完成后：驻留 1——最旧 alpha 被档化（loop 摘除），beta 仍驻留
      await vi.waitFor(() => expect(first.world.loop.get(sessionA)).toBeUndefined(), { timeout: 5_000 });
      expect(first.world.loop.get(sessionB)).toBeDefined();
      const listed = await callTool({ world: first.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
      expect(listed.content).not.toContain(sessionA);
      expect(listed.content).toContain(sessionB);
      await first.world.disposePlugins();

      // 纯内存（无 jsonl 插件）：档化被跳过——两个子都驻留（「可再 message」不毁约）
      const options = await makeOptions({ worker: { model: CHILD_MODEL } }, { maxResident: 1, maxConcurrent: 5 });
      const plain = await makeWorld(options);
      const plainParent = await spawnParent(plain);
      plain.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      plain.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "one"), textScript(CHILD_MODEL, "two")]);
      const c1 = await callTool({ world: plain, name: "agent_spawn", args: { description: "d", prompt: "a", subagent_type: "worker" }, session: plainParent.agent.session.id });
      const c2 = await callTool({ world: plain, name: "agent_spawn", args: { description: "d", prompt: "b", subagent_type: "worker" }, session: plainParent.agent.session.id });
      const s1 = sessionOf(c1.content);
      const s2 = sessionOf(c2.content);
      await vi.waitFor(() => {
        expect(hasTurnEnd(plain, s2)).toBe(true);
      }, { timeout: 5_000 });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100); // 等潜在档化窗口过
      });
      expect(plain.loop.get(s1)).toBeDefined(); // 未被档化（无盘不踢）
      expect(plain.loop.get(s2)).toBeDefined();
      await plainParent.dispose();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

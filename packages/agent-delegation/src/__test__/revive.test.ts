import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionStore } from "@x-harness/session";
import type { SessionId } from "@x-harness/session";
import { createJsonlSessionPersistence } from "@x-harness/session-persistence-jsonl";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, resetWorlds, sessionOf } from "./world.ts";
import type { World } from "./world.ts";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { worktreeParent } from "../worktree.ts";

const exec = promisify(execFile);

const grantsStub = (): Plugin => ({
  name: "grants-stub",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
});

async function worktreePersistedWorld(root: string, repoTop: string) {
  const options = await makeOptions({}, { workspaceRoot: repoTop, worktreeSweep: false });
  const world = await makeWorld(options, undefined, [grantsStub(), createJsonlSessionPersistence({ root })]);
  const parent = await spawnParent(world, PARENT_MODEL, "wtp" as never);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  return { world, parent };
}

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
      await first.world.disposePlugins();

      const second = await persistedWorld(root, {}, false);
      second.world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "awake again")]);
      second.world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "second life")]);
      const resumed = await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      expect(resumed.ok).toBe(true);
      const woke = await callTool({ world: second.world, name: "agent_message", args: { to: agentId, message: "wake up" }, session: first.parent.agent.session.id });
      expect(woke.isError).toBeUndefined();
      expect(woke.content).toContain(agentId);
      const listed = await callTool({ world: second.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
      expect(listed.content).toContain(childSession);
      await vi.waitFor(() => {
        expect(turnEndCount(second.world, childSession)).toBe(2);
      }, { timeout: 5_000 });
      const childEvents = second.world.ctx.use(sessionStore).get(childSession)?.events() ?? [];
      expect(JSON.stringify(childEvents)).toContain("you are the worker");
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

      const emptyDirOptions = await makeOptions({});
      const agentsDir = emptyDirOptions.agentsDirs?.[0] as string;
      const after = await makeWorld({ agentsDirs: [agentsDir], workspaceRoot: process.cwd() }, undefined, [createJsonlSessionPersistence({ root })]);
      await after.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const noType = await callTool({ world: after, name: "agent_message", args: { to: agentId, message: "hi" }, session: first.parent.agent.session.id });
      expect(noType.isError).toBe(true);
      expect(noType.content).toContain("not-found");
      await after.disposePlugins();

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
      await vi.waitFor(() => expect(first.world.loop.get(sessionA)).toBeUndefined(), { timeout: 5_000 });
      expect(first.world.loop.get(sessionB)).toBeDefined();
      const listed = await callTool({ world: first.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
      expect(listed.content).not.toContain(sessionA);
      expect(listed.content).toContain(sessionB);
      await first.world.disposePlugins();

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
        setTimeout(resolve, 100);
      });
      expect(plain.loop.get(s1)).toBeDefined();
      expect(plain.loop.get(s2)).toBeDefined();
      await plainParent.dispose();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("worktree 子复活（N2——replayWorktree/mainRepoTopOf 执行覆盖）", () => {
  it("复活重放 rootOverride：guard=主仓顶（非 worktree 路径）+ 行落账 worktreeRepoTop", async () => {
    const parent = mkdtempSync(join(mkdtempSync(join(tmpdir(), "xh-rev-wt-p-")), "d-"));
    const dir = join(parent, "repo");
    mkdirSync(dir, { recursive: true });
    const repoTop = realpathSync(dir);
    try {
      await exec("git", ["-C", repoTop, "init"]);
      await exec("git", ["-C", repoTop, "config", "user.email", "t@t"]);
      await exec("git", ["-C", repoTop, "config", "user.name", "t"]);
      writeFileSync(join(repoTop, "SEED.md"), "seed\n");
      await exec("git", ["-C", repoTop, "add", "."]);
      await exec("git", ["-C", repoTop, "commit", "-m", "seed"]);

      const persistence = mkdtempSync(join(tmpdir(), "xh-rev-wt-store-"));
      try {
        const first = await worktreePersistedWorld(persistence, repoTop);
        const spawned = await callTool({ world: first.world, name: "agent_spawn", args: { description: "iso work", prompt: "x", isolation: "worktree" }, session: first.parent.agent.session.id });
        expect(spawned.isError).toBeUndefined();
        const agentId = (spawned.content.match(/agent-[0-9a-f]{8}/) ?? [""])[0] as string;
        const childSession = sessionOf(spawned.content);
        const { readdir } = await import("node:fs/promises");
        const wtEntry = (await readdir(worktreeParent(repoTop))).find((f) => f.includes(agentId)) ?? "";
        const wtPath = join(worktreeParent(repoTop), wtEntry);
        writeFileSync(join(wtPath, "DIRTY.md"), "keep me\n");
        await first.world.ctx.use(sessionStore).flush(childSession);
        await first.world.ctx.use(sessionStore).flush(first.parent.agent.session.id);
        await first.world.disposePlugins();

        const second = await worktreePersistedWorld(persistence, repoTop);
        await second.world.loop.resume({ id: first.parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
        const revived = await callTool({ world: second.world, name: "agent_message", args: { to: agentId, message: "continue" }, session: first.parent.agent.session.id });
        expect(revived.isError).toBeUndefined();
        const listed = await callTool({ world: second.world, name: "list_agents", args: {}, session: first.parent.agent.session.id });
        expect(listed.content).toContain(agentId);

        const grants = second.world.ctx.tryUse(permissionGrants);
        expect(grants?.rootOverrideOf(childSession)).toEqual({ dir: wtPath, guard: repoTop });
        const { rm: rmFile } = await import("node:fs/promises");
        await rmFile(join(wtPath, "DIRTY.md")).catch(() => {});
        const stopped = await callTool({ world: second.world, name: "task_stop", args: { task_id: agentId }, session: first.parent.agent.session.id });
        expect(stopped.isError).toBeUndefined();
        expect(stopped.content).not.toContain("FAILED");
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        const branches = await exec("git", ["-C", repoTop, "branch", "--list", `x-harness/${agentId}`]);
        expect(branches.stdout.trim()).toBe("");
        await second.parent.dispose();
        await second.world.disposePlugins();
        await rm(wtPath, { recursive: true, force: true }).catch(() => {});
      } finally {
        await rm(persistence, { recursive: true, force: true }).catch(() => {});
      }
    } finally {
      await rm(worktreeParent(repoTop), { recursive: true, force: true }).catch(() => {});
      await rm(dirname(parent), { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});

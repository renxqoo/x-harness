import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, CHILD_MODEL, makeOptions, resetWorlds, agentIdOf } from "./world.ts";
import { agentSpawned, agentWorktreeGone } from "../tokens.ts";
import type { AgentSpawnedPayload, AgentWorktreeGonePayload } from "../tokens.ts";
import { worktreeParent } from "../worktree.ts";

const exec = promisify(execFile);

let repo: string | undefined;
let fixtureRoot: string | undefined;

beforeEach(() => {
  resetWorlds();
});

afterEach(async () => {
  if (repo !== undefined) await rm(worktreeParent(repo), { recursive: true, force: true }).catch(() => {});
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  fixtureRoot = undefined;
  repo = undefined;
});

async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "xh-wtcx-p-"));
  fixtureRoot = root;
  const parent = mkdtempSync(join(root, "d-"));
  const dir = join(parent, "repo");
  mkdirSync(dir);
  await exec("git", ["-C", dir, "init"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t"]);
  await exec("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  return realpathSync(dir);
}

const grantsStub = (): Plugin => ({
  name: "grants-stub",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
});

async function typedWorktreeWorld() {
  const options = await makeOptions({ worker: { model: CHILD_MODEL, body: "you are a worker" } }, { workspaceRoot: repo as string, worktreeSweep: false });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "wtcx-main" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  world.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "c")]);
  return { world, parent };
}

describe("worktree 上下文事件与环境块", { timeout: 20_000 }, () => {
  it("spawn(isolation=worktree)：payload 含 worktree/branch/worktreeMain（.git 解析真值）；named 子 options 拼环境块（Track N）", async () => {
    repo = await gitRepo();
    const twins = await typedWorktreeWorld();
    const spawnedLog: AgentSpawnedPayload[] = [];
    twins.world.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
    const spawned = await callTool({
      world: twins.world,
      name: "agent_spawn",
      args: { description: "isolated work", prompt: "x", subagent_type: "worker", isolation: "worktree" },
      session: twins.parent.agent.session.id,
    });
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const entry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId));
    expect(entry).toBeDefined();
    const wtPath = join(worktreeParent(repo), entry ?? "");
    const payload = spawnedLog.find((p) => p.agentId === agentId);
    expect(payload).toBeDefined();
    expect(payload?.worktree).toBe(wtPath);
    expect(payload?.branch).toBe(`x-harness/${agentId}`);
    expect(payload?.worktreeMain).toBe(repo);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    const child = twins.world.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken).get(childSession);
    expect(child?.agent.options.systemPrompt).toContain("you are a worker");
    expect(child?.agent.options.systemPrompt).toContain(`- Working directory: ${wtPath}`);
    expect(child?.agent.options.systemPrompt).toContain(`- Git branch: x-harness/${agentId}`);
    expect(child?.agent.options.systemPrompt).toContain(`- Main repository (read-only reference, outside your sandbox): ${repo}`);
    await twins.parent.dispose();
  });

  it("非 worktree named 子：systemPrompt 逐字节 = 类型正文（零改动回归锚）", async () => {
    repo = await gitRepo();
    const twins = await typedWorktreeWorld();
    const spawnedLog: AgentSpawnedPayload[] = [];
    twins.world.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
    const spawned = await callTool({
      world: twins.world,
      name: "agent_spawn",
      args: { description: "plain work", prompt: "x", subagent_type: "worker" },
      session: twins.parent.agent.session.id,
    });
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const payload = spawnedLog.find((p) => p.agentId === agentId);
    expect(payload?.worktree).toBeUndefined();
    expect(payload?.branch).toBeUndefined();
    expect(payload?.worktreeMain).toBeUndefined();
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    const child = twins.world.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken).get(childSession);
    expect(child?.agent.options.systemPrompt).toBe("you are a worker");
    await twins.parent.dispose();
  });

  it("stop removed → agentWorktreeGone 恰一次（树删+会话驻留）；kept-dirty 不发", async () => {
    repo = await gitRepo();
    const twins = await typedWorktreeWorld();
    const spawned = await callTool({
      world: twins.world,
      name: "agent_spawn",
      args: { description: "isolated work", prompt: "x", isolation: "worktree" },
      session: twins.parent.agent.session.id,
    });
    const agentId = agentIdOf(spawned.content);
    const entry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), entry);
    const goneLog: AgentWorktreeGonePayload[] = [];
    twins.world.ctx.on(agentWorktreeGone, (payload) => goneLog.push(payload));
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(goneLog).toHaveLength(1);
    expect(goneLog[0]).toMatchObject({ sessionId: childSession, agentId });
    expect(existsSync(wtPath)).toBe(false);
    await twins.parent.dispose();
  });

  it("kept-dirty stop 不发 gone（树仍活——可复活，覆盖层保留）", async () => {
    repo = await gitRepo();
    const twins = await typedWorktreeWorld();
    const spawned = await callTool({
      world: twins.world,
      name: "agent_spawn",
      args: { description: "isolated work", prompt: "x", isolation: "worktree" },
      session: twins.parent.agent.session.id,
    });
    const agentId = agentIdOf(spawned.content);
    const entry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    writeFileSync(join(worktreeParent(repo), entry, "NEW.md"), "dirty\n");
    const goneLog: AgentWorktreeGonePayload[] = [];
    twins.world.ctx.on(agentWorktreeGone, (payload) => goneLog.push(payload));
    await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(goneLog).toHaveLength(0);
    await twins.parent.dispose();
  });

  it("get_subagents（ChildView）含 worktree 字段", async () => {
    repo = await gitRepo();
    const twins = await typedWorktreeWorld();
    const spawned = await callTool({
      world: twins.world,
      name: "agent_spawn",
      args: { description: "isolated work", prompt: "x", isolation: "worktree" },
      session: twins.parent.agent.session.id,
    });
    const agentId = agentIdOf(spawned.content);
    const entry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId));
    const listed = await callTool({ world: twins.world, name: "list_agents", args: {}, session: twins.parent.agent.session.id });
    expect(listed.content).toContain(agentId);
    expect(listed.content).toContain(join(worktreeParent(repo), entry ?? ""));
    await twins.parent.dispose();
  });

  it("revive 复活：payload 三字段经预解析（branch 读 gitdir HEAD）+ options 环境块重建", async () => {
    repo = await gitRepo();
    const { createJsonlSessionPersistence } = await import("@x-harness/session-persistence-jsonl");
    const { sessionStore } = await import("@x-harness/session");
    const persistRoot = mkdtempSync(join(tmpdir(), "xh-wtcx-s-"));
    const makePersistedWorld = async () => {
      const options = await makeOptions({ worker: { model: CHILD_MODEL, body: "you are a worker" } }, { workspaceRoot: repo as string, worktreeSweep: false });
      return makeWorld(options, undefined, [grantsStub(), createJsonlSessionPersistence({ root: persistRoot })]);
    };
    try {
      const first = await makePersistedWorld();
      const parent = await spawnParent(first, PARENT_MODEL, "wtcx-rv" as SessionId);
      first.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
      first.scripts.set(CHILD_MODEL, [textScript(CHILD_MODEL, "c")]);
      const spawned = await callTool({
        world: first,
        name: "agent_spawn",
        args: { description: "isolated work", prompt: "x", subagent_type: "worker", isolation: "worktree" },
        session: parent.agent.session.id,
      });
      const agentId = agentIdOf(spawned.content);
      const childSession0 = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
      const entry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
      const wtPath = join(worktreeParent(repo), entry);
      writeFileSync(join(wtPath, "KEEP.md"), "dirty\n");
      await first.ctx.use(sessionStore).flush(childSession0);
      await first.ctx.use(sessionStore).flush(parent.agent.session.id);
      await first.disposePlugins();

      const second = await makePersistedWorld();
      await second.loop.resume({ id: parent.agent.session.id, agent: { model: PARENT_MODEL, provider: "fake" } });
      const spawnedLog: AgentSpawnedPayload[] = [];
      second.ctx.on(agentSpawned, (payload) => spawnedLog.push(payload));
      const revived = await callTool({ world: second, name: "agent_message", args: { to: agentId, message: "continue" }, session: parent.agent.session.id });
      expect(revived.isError).toBeUndefined();
      const payload = spawnedLog.find((p) => p.agentId === agentId);
      expect(payload?.worktree).toBe(wtPath);
      expect(payload?.branch).toBe(`x-harness/${agentId}`);
      expect(payload?.worktreeMain).toBe(repo);
      const child = second.ctx.use((await import("@x-harness/agent-loop")).agentLoopServiceToken).get(payload?.sessionId as never);
      expect(child?.agent.options.systemPrompt).toContain("you are a worker");
      expect(child?.agent.options.systemPrompt).toContain(`- Working directory: ${wtPath}`);
      await second.loop.get(parent.agent.session.id)?.dispose();
      await second.disposePlugins();
    } finally {
      await rm(persistRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});

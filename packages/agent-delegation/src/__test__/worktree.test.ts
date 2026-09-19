// worktree 隔离测试（docs/AGENT-DELEGATION.md §8/§11.2）：真 git 仓夹具（chdir 进出）、
// repo 外路径、授权根落账、无改动清理（stop/teardown）、有改动保留带路径、非 git 仓拒、
// git 串行、启动期清扫。

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "@x-harness/core";
import { GrantsRegistry, permissionGrants } from "@x-harness/permission";
import type { SessionId } from "@x-harness/session";
import { makeWorld, spawnParent, callTool, textScript, PARENT_MODEL, makeOptions, resetWorlds, agentIdOf } from "./world.ts";
import { createWorktree, sweepWorktrees, worktreeParent } from "../worktree.ts";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

let repo: string | undefined;
let prevCwd: string;
let scratch: string[] = [];

beforeEach(() => {
  resetWorlds();
  prevCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (repo !== undefined) await rm(worktreeParent(repo), { recursive: true, force: true }).catch(() => {});
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
  scratch = [];
});

async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "xh-wt-repo-"));
  scratch = [...scratch, dir];
  process.chdir(dir);
  await exec("git", ["init"]);
  await exec("git", ["config", "user.email", "t@t"]);
  await exec("git", ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  await exec("git", ["add", "."]);
  await exec("git", ["commit", "-m", "seed"]);
  return realpathSync(dir); // git rev-parse 返回物理路径（/private/var）——测试全程用物理形
}

const grantsStub = (): Plugin => ({
  name: "grants-stub",
  apply: (ctx) => ctx.provide(permissionGrants, new GrantsRegistry()),
});

async function worktreeWorld() {
  const options = await makeOptions({}, { worktreeSweep: false });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  return { world, parent };
}

const spawnWorktree = (world: Awaited<ReturnType<typeof worktreeWorld>>) =>
  callTool({ world: world.world, name: "agent_spawn", args: { description: "isolated work", prompt: "x", isolation: "worktree" }, session: world.parent.agent.session.id });

describe("worktree 隔离（§8）", () => {
  it("isolation=worktree：repo 外路径建树 + 授权根落账（真隔离）；stop 无改动自动清理（树与分支消失）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const parentDir = worktreeParent(repo);
    const entry = (await readdir(parentDir)).find((f) => f.includes(agentId));
    expect(entry).toBeDefined(); // repo 外同级 .x-harness-worktrees/<repo>-<agentId>
    const wtPath = join(parentDir, entry ?? "");
    expect(existsSync(join(wtPath, "README.md"))).toBe(true); // HEAD 检出
    // 授权根落账：子会话 override = worktree、guard = repo
    const grants = twins.world.ctx.tryUse(permissionGrants);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    expect(grants?.rootOverrideOf(childSession)).toEqual({ dir: wtPath, guard: repo });
    // 无改动 stop → 清理
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).not.toContain("worktree kept");
    await sleep(50);
    expect(existsSync(wtPath)).toBe(false);
    const branches = await exec("git", ["branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe("");
    await twins.parent.dispose();
  });

  it("有改动 stop → worktree 保留且文案带路径", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    writeFileSync(join(wtPath, "NEW.md"), "changes\n"); // 子工作区弄脏
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).toContain(`worktree kept (has changes): ${wtPath}`);
    expect(existsSync(wtPath)).toBe(true); // 改动不丢
    await twins.parent.dispose();
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });

  it("非 git 仓 → spawn-failed:worktree 且无残留分支", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-wt-plain-"));
    scratch = [...scratch, dir];
    process.chdir(dir);
    const twins = await worktreeWorld();
    const refused = await callTool({ world: twins.world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: twins.parent.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("spawn-failed:worktree");
    expect(refused.content).toContain("not-a-git-repo");
    await twins.parent.dispose();
  });

  it("isolation 非法值 → invalid-args；grants 缺位 → worktree 拒（不半装）", async () => {
    repo = await gitRepo();
    const bad = await makeOptions({}, { worktreeSweep: false });
    const worldNoGrants = await makeWorld(bad); // 无 grants-stub
    const parent = await spawnParent(worldNoGrants);
    worldNoGrants.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const invalid = await callTool({ world: worldNoGrants, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "remote" }, session: parent.agent.session.id });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("invalid-args:isolation");
    const noGrants = await callTool({ world: worldNoGrants, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(noGrants.isError).toBe(true);
    expect(noGrants.content).toContain("requires the permission grants service");
    const listed = await callTool({ world: worldNoGrants, name: "list_agents", args: {}, session: parent.agent.session.id });
    expect(listed.content).toContain("(no sub-agents)"); // 不半装（无孤儿行）
    // 半建产物清理：worktree 目录不残留
    expect(existsSync(worktreeParent(repo))).toBe(false);
    await parent.dispose();
  });

  it("git 串行队列：并发两 worktree spawn 均成且路径互异", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const [a, b] = await Promise.all([spawnWorktree(twins), spawnWorktree(twins)]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(agentIdOf(a.content)).not.toBe(agentIdOf(b.content));
    const entries = (await readdir(worktreeParent(repo))).filter((f) => f.includes(agentIdOf(a.content)) || f.includes(agentIdOf(b.content)));
    expect(entries).toHaveLength(2);
    await twins.parent.dispose();
  });

  it("启动期清扫：净树+分支被清、脏树保留（sweepWorktrees 直测，now 注入超龄）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-sweep01");
    expect(made.ok).toBe(true);
    const dirty = await createWorktree("agent-sweep02");
    expect(dirty.ok).toBe(true);
    if (dirty.ok) writeFileSync(join(dirty.plan.path, "CHANGE.md"), "x");
    const aged = (): number => Date.now() + 2 * 3_600_000; // 目录 mtime 判超龄
    const kept = await sweepWorktrees([], aged);
    expect(kept).toHaveLength(1); // 脏树保留
    if (made.ok) {
      expect(existsSync(made.plan.path)).toBe(false); // 净树被清
      const branches = await exec("git", ["branch", "--list", "x-harness/agent-sweep01"]);
      expect(branches.stdout.trim()).toBe(""); // 分支同删（审查 B-P1-4 回归锚）
    }
    if (dirty.ok) await rm(dirty.plan.path, { recursive: true, force: true }).catch(() => {});
  });

  it("新鲜树不清（FRESH_MS 窗内——同仓他进程在用工作树防线）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-fresh01");
    expect(made.ok).toBe(true);
    const kept = await sweepWorktrees([]); // 缺省 now=Date.now → mtime 新鲜
    expect(kept).toHaveLength(0); // 不清也不报 kept（跳过）
    if (made.ok) expect(existsSync(made.plan.path)).toBe(true);
  });

  it("teardown 级联：插件 dispose 清理子的 worktree（净树）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await twins.world.disposePlugins();
    await sleep(50);
    expect(existsSync(wtPath)).toBe(false);
  });

  it("路径形态：worktreeParent 在 repo 外同级（不落 .git 受保护区）", async () => {
    repo = await gitRepo();
    expect(worktreeParent(repo)).toBe(join(dirname(repo), ".x-harness-worktrees"));
    expect(worktreeParent(repo).startsWith(join(repo, ".git"))).toBe(false);
    expect(basename(worktreeParent(repo))).toBe(".x-harness-worktrees");
  });
});

describe("组合隔离（§8.2 工具参数面 × grants 子会话键——审查 A-P1-4 处置）", () => {
  it("worktree 子会话视角：worktree 路径放行、主仓路径拒、原根子树授权被过滤", async () => {
    repo = await gitRepo();
    const repoNow = repo; // 闭包内保收窄（模块级 let 不跨闭包窄化）
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    expect(spawned.isError).toBeUndefined();
    const agentId = agentIdOf(spawned.content);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    const { PathGate, admitSession } = await import("../../../toolbox/src/paths.ts");
    const gate = new PathGate(repoNow);
    const rp = async (p: string) => p;
    const grants = twins.world.ctx.tryUse(permissionGrants);
    const overrideOf = (session: SessionId | undefined) => grants?.rootOverrideOf(session);
    const extraRootsOf = (session: SessionId | undefined) => (session === childSession ? [join(repoNow, "sub")] : []);
    const inside = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(wtPath, "file.ts") });
    expect(inside.ok).toBe(true); // 子视角：worktree 内放行
    const outside = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "secret.ts") });
    expect(outside.ok).toBe(false); // 子视角：主仓不可达
    const viaGuarded = await admitSession({ gate, realpath: rp, session: childSession, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "sub", "x.ts") });
    expect(viaGuarded.ok).toBe(false); // 原根子树授权被过滤
    const parentView = await admitSession({ gate, realpath: rp, session: twins.parent.agent.session.id, extraRootsOf, rootOverrideOf: overrideOf, target: join(repoNow, "secret.ts") });
    expect(parentView.ok).toBe(true); // 父视角不受影响
    await twins.parent.dispose();
  });
});

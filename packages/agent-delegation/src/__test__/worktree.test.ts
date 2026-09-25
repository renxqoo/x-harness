// worktree 隔离测试（docs/AGENT-DELEGATION.md §8/§11.2 + docs/WORKSPACE-ROOT-INJECTION.md）：
// hub 形态（进程 cwd 停仓外、workspaceRoot 指真仓——不 chdir）、repo 外路径、授权根落账、
// 无改动清理（stop/teardown）、有改动保留带路径、remove 失败可见、非 git 仓拒、无关祖先仓拒、
// git 串行、per-repo lockfile、启动期清扫。

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
import { createWorktree, evaluateCleanup, sweepWorktrees, worktreeParent } from "../worktree.ts";
import { withRepoLock, repoLockPath } from "../lockfile.ts";

const exec = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

let repo: string | undefined;
let scratch: string[] = [];

beforeEach(() => {
  resetWorlds();
});

afterEach(async () => {
  if (repo !== undefined) await rm(worktreeParent(repo), { recursive: true, force: true }).catch(() => {});
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
  scratch = [];
  repo = undefined;
});

/** 真仓夹具：git -C 显式（无 ambient cwd 依赖）；返回物理路径（rev-parse 同口径） */
async function gitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "xh-wt-repo-"));
  scratch = [...scratch, dir];
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

/** worktree 世界：workspaceRoot 显式指仓（进程 cwd 留在 x-harness 仓根——hub 形态） */
async function worktreeWorld(overrides: { readonly onWarn?: (m: string) => void } = {}) {
  const options = await makeOptions({}, { workspaceRoot: repo as string, worktreeSweep: false, ...(overrides.onWarn !== undefined ? { onWarn: overrides.onWarn } : {}) });
  const world = await makeWorld(options, undefined, [grantsStub()]);
  const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
  world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
  return { world, parent };
}

const spawnWorktree = (world: Awaited<ReturnType<typeof worktreeWorld>>) =>
  callTool({ world: world.world, name: "agent_spawn", args: { description: "isolated work", prompt: "x", isolation: "worktree" }, session: world.parent.agent.session.id });

describe("worktree 隔离（§8）", () => {
  it("hub 形态（进程 cwd 在仓外）：repo 外路径建树 + 授权根落账（真隔离）；task_stop 无改动自动清理（树与分支消失）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    expect(spawned.isError).toBeUndefined(); // 进程 cwd 在 x-harness 仓根、workspaceRoot 指真仓——不依赖 ambient cwd
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
    // 无改动 stop（task_stop 面——hub 清理主路径）→ 清理
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).not.toContain("worktree kept");
    await sleep(50);
    expect(existsSync(wtPath)).toBe(false);
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe(""); // 分支双清（hub 清理泄漏回归锚）
    await twins.parent.dispose();
  });

  it("有改动 stop → worktree 保留且文案带路径（kept-dirty）", async () => {
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

  it("remove 失败可见：git worktree lock 制造 → stop 文案报 remove-failed（非 has changes）+ onWarn 告警", async () => {
    repo = await gitRepo();
    const warnings: string[] = [];
    const twins = await worktreeWorld({ onWarn: (m) => warnings.push(m) });
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await exec("git", ["-C", repo, "worktree", "lock", wtPath]); // remove --force 不越锁（退出 128）
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).not.toContain("has changes"); // 判别拆分：失败 ≠ 谎报有改动
    expect(stopped.content).toContain("worktree cleanup FAILED");
    expect(warnings.join("\n")).not.toBe(""); // 可见化：不再静默吞
    expect(existsSync(wtPath)).toBe(true); // 树还在（如实）
    await twins.parent.dispose();
    await exec("git", ["-C", repo, "worktree", "unlock", wtPath]).catch(() => {});
    await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  });

  it("existsSync 早退：目录被外部删除 → stop 仍清分支（第三条泄漏路径回归锚）", async () => {
    repo = await gitRepo();
    const twins = await worktreeWorld();
    const spawned = await spawnWorktree(twins);
    const agentId = agentIdOf(spawned.content);
    const wtEntry = (await readdir(worktreeParent(repo))).find((f) => f.includes(agentId)) ?? "";
    const wtPath = join(worktreeParent(repo), wtEntry);
    await rm(wtPath, { recursive: true, force: true }); // 外部 rm（hub 多进程 prune 同形）
    const stopped = await callTool({ world: twins.world, name: "task_stop", args: { task_id: agentId }, session: twins.parent.agent.session.id });
    expect(stopped.content).not.toContain("FAILED");
    const branches = await exec("git", ["-C", repo, "branch", "--list", `x-harness/${agentId}`]);
    expect(branches.stdout.trim()).toBe(""); // 分支不泄漏
    await twins.parent.dispose();
  });

  it("非 git 仓（workspaceRoot 指向）→ spawn-failed:worktree not-a-git-repo 且无残留分支", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-wt-plain-"));
    scratch = [...scratch, dir];
    const physical = realpathSync(dir);
    const options = await makeOptions({}, { workspaceRoot: physical, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const refused = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("spawn-failed:worktree");
    expect(refused.content).toContain("not-a-git-repo");
    await parent.dispose();
  });

  it("workspaceRoot 在仓内子目录 → rev-parse 上溯仓根建树（合法通过）", async () => {
    repo = await gitRepo();
    const sub = join(repo, "pkg");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sub);
    const physical = realpathSync(repo);
    const options = await makeOptions({}, { workspaceRoot: sub, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const spawned = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(spawned.isError).toBeUndefined(); // 子目录 → 上溯仓根（guard 是仓根）
    const grants = world.ctx.tryUse(permissionGrants);
    const childSession = (spawned.content.match(/session ([A-Za-z0-9._-]+)/) ?? [""])[1] as SessionId;
    expect(grants?.rootOverrideOf(childSession)?.guard).toBe(physical);
    await parent.dispose();
  });

  it("workspaceRoot 撞无关祖先仓 → workspace-not-in-repo 拒（不写祖先仓）", async () => {
    // 外层仓（祖先）内建内层工作目录（非子模块、无 .git）
    const outer = mkdtempSync(join(tmpdir(), "xh-wt-outer-"));
    scratch = [...scratch, outer];
    await exec("git", ["-C", outer, "init"]);
    await exec("git", ["-C", outer, "config", "user.email", "t@t"]);
    await exec("git", ["-C", outer, "config", "user.name", "t"]);
    writeFileSync(join(outer, "DOT.md"), "dotfiles\n");
    await exec("git", ["-C", outer, "add", "."]);
    await exec("git", ["-C", outer, "commit", "-m", "dot"]);
    const workspace = join(outer, "workspace"); // 工作区在祖先仓内但与它无关
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    const options = await makeOptions({}, { workspaceRoot: workspace, worktreeSweep: false });
    const world = await makeWorld(options, undefined, [grantsStub()]);
    const parent = await spawnParent(world, PARENT_MODEL, "wt-main" as SessionId);
    world.scripts.set(PARENT_MODEL, [textScript(PARENT_MODEL, "p")]);
    const refused = await callTool({ world, name: "agent_spawn", args: { description: "d", prompt: "x", isolation: "worktree" }, session: parent.agent.session.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("workspace-not-in-repo"); // rev-parse 命中外层仓 → 拒
    await parent.dispose();
  });

  it("isolation 非法值 → invalid-args；grants 缺位 → worktree 拒（不半装）", async () => {
    repo = await gitRepo();
    const bad = await makeOptions({}, { workspaceRoot: repo, worktreeSweep: false });
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
    // 半建产物清理：无 worktree 残留（lockfile 目录瞬态在场不算——按名过滤）
    const leftovers = (await readdir(worktreeParent(repo)).catch(() => [] as string[])).filter((f) => !f.startsWith("repo-"));
    expect(leftovers).toHaveLength(0);
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
    const made = await createWorktree("agent-sweep01", repo);
    expect(made.ok).toBe(true);
    const dirty = await createWorktree("agent-sweep02", repo);
    expect(dirty.ok).toBe(true);
    if (dirty.ok) writeFileSync(join(dirty.plan.path, "CHANGE.md"), "x");
    const aged = (): number => Date.now() + 2 * 3_600_000; // 目录 mtime 判超龄
    const kept = await sweepWorktrees([], repo, aged);
    expect(kept).toHaveLength(1); // 脏树保留
    if (made.ok) {
      expect(existsSync(made.plan.path)).toBe(false); // 净树被清
      const branches = await exec("git", ["-C", repo, "branch", "--list", "x-harness/agent-sweep01"]);
      expect(branches.stdout.trim()).toBe(""); // 分支同删（审查 B-P1-4 回归锚）
    }
    if (dirty.ok) await rm(dirty.plan.path, { recursive: true, force: true }).catch(() => {});
  });

  it("新鲜树不清（FRESH_MS 窗内——同仓他进程在用工作树防线）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-fresh01", repo);
    expect(made.ok).toBe(true);
    const kept = await sweepWorktrees([], repo); // 缺省 now=Date.now → mtime 新鲜
    expect(kept).toHaveLength(0); // 不清也不报 kept（跳过）
    if (made.ok) expect(existsSync(made.plan.path)).toBe(true);
  });

  it("livePaths 活行不清（误删防线第一层——同进程在用工作树）", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-live01", repo);
    expect(made.ok).toBe(true);
    const aged = (): number => Date.now() + 2 * 3_600_000; // 超龄也保护——livePaths 优先于 FRESH_MS
    if (made.ok) {
      const kept = await sweepWorktrees([made.plan.path], repo, aged);
      expect(kept).toHaveLength(0);
      expect(existsSync(made.plan.path)).toBe(true);
    }
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

  it("清理锚定 repoTop（持久化事实）：跨装配换 cwd 后 stop 仍删对树", async () => {
    repo = await gitRepo();
    const made = await createWorktree("agent-anchor01", repo);
    expect(made.ok).toBe(true);
    if (made.ok) {
      // 模拟「另一装配」：plan 里 repoTop 是落账事实，evaluateCleanup 不读任何当次 cwd
      const result = await evaluateCleanup(made.plan);
      expect(result.kind).toBe("removed");
      expect(existsSync(made.plan.path)).toBe(false);
      const branches = await exec("git", ["-C", repo, "branch", "--list", "x-harness/agent-anchor01"]);
      expect(branches.stdout.trim()).toBe("");
    }
  });
});

describe("per-repo lockfile（跨进程写互斥）", () => {
  it("互斥：持锁期间第二个临界区等待（串行执行）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-"));
    scratch = [...scratch, dir];
    const order: string[] = [];
    const lock = join(dir, "repo-test.lock");
    const first = withRepoLock(lock, async () => {
      order.push("a-start");
      await sleep(60);
      order.push("a-end");
    });
    await sleep(30); // a 先持锁（同 tick 启动则是 mkdir 竞速——顺序非断言面，互斥才是）
    const second = withRepoLock(lock, async () => {
      order.push("b-start");
      await sleep(10);
      order.push("b-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]); // 不交错
  });

  it("stale 抢占：持锁 pid 死亡 → 后来者可抢", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-stale-"));
    scratch = [...scratch, dir];
    const lock = join(dir, "repo-test.lock");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(lock); // 死锁残留：锁目录存在
    await writeFile(join(lock, "pid"), "999999999"); // 无此 pid（32 位上限外安全死值）
    let ran = false;
    await withRepoLock(lock, async () => {
      ran = true;
    });
    expect(ran).toBe(true); // stale 被抢，不永久卡死
  });

  it("release 只删自己的锁（他者覆盖后不误删）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xh-lock-rel-"));
    scratch = [...scratch, dir];
    const lock = join(dir, "repo-test.lock");
    await withRepoLock(lock, async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(lock, "pid"), "12345"); // 临界区内他者抢占（模拟）
    });
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(lock, "pid"), "utf8")).toBe("12345"); // 不误删他者锁
  });

  it("repoLockPath 确定性：同 repoTop 同路径、异 repoTop 异路径", () => {
    expect(repoLockPath("/tmp/wt", "/Users/x/repo")).toBe(repoLockPath("/tmp/wt", "/Users/x/repo"));
    expect(repoLockPath("/tmp/wt", "/Users/x/repo")).not.toBe(repoLockPath("/tmp/wt", "/Users/x/other"));
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
    const { PathGate, admitSession } = await import("@x-harness/tool-core");
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
